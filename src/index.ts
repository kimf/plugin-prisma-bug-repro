import * as Prisma from '@prisma/sdk'
import chalk from 'chalk'
import { stripIndent } from 'common-tags'
import * as fs from 'fs-jetpack'
import { nexusPrismaPlugin, Options } from 'nexus-prisma'
import * as path from 'path'
import { Layout } from 'pumpkins/dist/framework/layout'
import { shouldGenerateArtifacts } from 'pumpkins/dist/framework/nexus'
import * as PumpkinsPlugin from 'pumpkins/dist/framework/plugin'
import { SuccessfulRunResult } from 'pumpkins/dist/utils'
import { suggestionList } from './lib/levenstein'
import { printStack } from './lib/print-stack'

type UnknownFieldName = {
  error: Error
  unknownFieldName: string
  validFieldNames: string[]
  typeName: string
}

export type UnknownFieldType = {
  unknownFieldType: string
  error: Error
  typeName: string
  fieldName: string
}

type OptionsWithHook = Options & {
  onUnknownFieldName: (params: UnknownFieldName) => void
  onUnknownFieldType: (params: UnknownFieldType) => void
}

// HACK
// 1. https://prisma-company.slack.com/archives/C8AKVD5HU/p1574267904197600
// 2. https://prisma-company.slack.com/archives/CEYCG2MCN/p1574267824465700
const GENERATED_PHOTON_OUTPUT_PATH = fs.path('node_modules/@prisma/photon')

export const create = PumpkinsPlugin.create(pumpkins => {
  const nexusPrismaTypegenOutput = fs.path(
    'node_modules/@types/typegen-nexus-prisma/index.d.ts'
  )

  pumpkins.workflow((hooks, { layout, packageManager }) => {
    pumpkins.utils.debug('Running workflow...')
    // build

    hooks.build.onStart = async () => {
      await runPrismaGenerators()
    }

    // create

    hooks.create.onAfterBaseSetup = async hctx => {
      if (hctx.database === undefined) {
        throw new Error(
          'Should never happen. Prisma plugin should not be installed if no database were chosen in the create workflow'
        )
      }

      const datasource = renderDatasource({
        database: hctx.database,
        connectionURI: hctx.connectionURI,
      })

      await Promise.all([
        fs.writeAsync(
          'prisma/schema.prisma',
          datasource +
            '\n' +
            stripIndent`
    
            generator photon {
              provider = "photonjs"
            }
    
            model World {
              id         Int     @id
              name       String  @unique
              population Float
            }
          `
        ),
        fs.writeAsync(
          'prisma/seed.ts',
          stripIndent`
            import { Photon } from "@prisma/photon"
    
            const photon = new Photon()
            
            main()
            
            async function main() {
              const result = await photon.worlds.create({
                data: {
                  name: "Earth",
                  population: 6_000_000_000
                }
              })
            
              console.log("Seeded: %j", result)
            
              photon.disconnect()
            }
          `
        ),
        fs.writeAsync(
          layout.sourcePath('schema.ts'),
          stripIndent`
            import { app } from "pumpkins"
            import { stringArg } from "nexus"
    
            app.objectType({
              name: "World",
              definition(t) {
                t.model.id()
                t.model.name()
                t.model.population()
              }
            })
    
            app.queryType({
              definition(t) {
                t.field("hello", {
                  type: "World",
                  args: {
                    world: stringArg({ required: false })
                  },
                  async resolve(_root, args, ctx) {
                    const worldToFindByName = args.world ?? 'Earth'
                    const world = await ctx.photon.worlds.findOne({
                      where: {
                        name: worldToFindByName
                      }
                    })
    
                    if (!world) throw new Error(\`No such world named "\${args.world}"\`)
    
                    return world
                  }
                })
              }
            })
          `
        ),
        fs.writeAsync(
          'pumpkins.config.ts',
          stripIndent`
            import { createConfig } from 'pumpkins/config'

            export default createConfig({
              environments: {
                development: {
                  PUMPKINS_DATABASE_URL: "${renderConnectionURI(
                    {
                      database: hctx.database,
                      connectionURI: hctx.connectionURI,
                    },
                    layout
                  )}"
                }
              }
            })
        `
        ),
      ])

      if (hctx.connectionURI || hctx.database === 'SQLite') {
        pumpkins.utils.log.successBold('Initializing development database...')
        // TODO expose run on pumpkins
        await packageManager.runBin(
          'prisma2 lift save --create-db --name init',
          {
            require: true,
          }
        )
        await packageManager.runBin('prisma2 lift up', { require: true })

        pumpkins.utils.log.info('Generating photon...')
        await packageManager.runBin('prisma2 generate', { require: true })

        pumpkins.utils.log.info('Seeding development database...')
        await packageManager.runBin('ts-node prisma/seed', {
          require: true,
        })
      } else {
        pumpkins.utils.log.info(stripIndent`
          1. Please setup your ${hctx.database} and fill in the connection uri in your \`pumpkins.config.ts\` file.
        `)
        pumpkins.utils.log.info(stripIndent`
          2. Run \`${packageManager.renderRunScript(
            'pumpkins db init'
          )}\` to initialize your database.
        `)
        pumpkins.utils.log.info(stripIndent`
          3. Run \`${packageManager.renderRunScript('dev')}\` to start working.
        `)
      }
    }

    // generate

    hooks.generate.onStart = async () => {
      await runPrismaGenerators()
    }

    // dev

    hooks.dev.onStart = async () => {
      await runPrismaGenerators()
    }

    hooks.dev.onFileWatcherEvent = (_event, file) => {
      if (file.match(/.*schema\.prisma$/)) {
        pumpkins.utils.log.info(
          chalk`Prisma Schema change detected, lifting...`
        )
        // Raw code being run is this https://github.com/prisma/lift/blob/dce60fe2c44e8a0d951d961187aec95a50a33c6f/src/cli/commands/LiftTmpPrepare.ts#L33-L45
        pumpkins.utils.debug('running lift...')
        const result = pumpkins.utils.run('prisma2 tmp-prepare', {
          require: true,
        })
        pumpkins.utils.debug('done %O', result)
      }
    }

    hooks.dev.addToSettings = {
      // TODO preferably we allow schema.prisma to be anywhere but they show up in
      // migrations folder too and we don't know how to achieve semantic "anywhere
      // but migrations folder"
      watchFilePatterns: ['./schema.prisma', './prisma/schema.prisma'],
    }

    hooks.db = {
      init: {
        onStart: async () => {
          const response = await packageManager.runBin(
            'prisma2 lift save --name init --create-db'
          )

          handleLiftResponse(
            pumpkins,
            response,
            'We could not initialize your database'
          )
        },
      },
      migrate: {
        apply: {
          onStart: async hctx => {
            if (!hctx.force) {
              const previewResponse = await packageManager.runBin(
                'prisma2 lift up --preview'
              )

              if (
                !handleLiftResponse(
                  pumpkins,
                  previewResponse,
                  'We could not run a dry-run of your migration'
                )
              ) {
                return
              }

              const { confirm } = await pumpkins.utils.prompt({
                type: 'confirm',
                name: 'confirm',
                message: 'Do you want to apply the above migration?',
              })

              if (!confirm) {
                pumpkins.utils.log.info('Migration not applied.')
                return
              }
            }

            console.log()
            const response = await packageManager.runBin('prisma2 lift up')

            handleLiftResponse(
              pumpkins,
              response,
              'We could not migrate your database'
            )
          },
        },
        plan: {
          onStart: async hctx => {
            const migrationName = hctx.migrationName
              ? `--name=${hctx.migrationName}`
              : ''
            const response = await packageManager.runBin(
              `prisma2 lift save ${migrationName}`
            )

            handleLiftResponse(
              pumpkins,
              response,
              'We could not generate a migration file'
            )
          },
        },
        rollback: {
          onStart: async () => {
            const response = await packageManager.runBin('prisma2 lift down')

            handleLiftResponse(
              pumpkins,
              response,
              'We could not rollback your migration'
            )
          },
        },
      },
    }
  })

  pumpkins.runtime(() => {
    pumpkins.utils.debug('Running runtime...')
    const { Photon } = require('@prisma/photon')
    const photon = new Photon()

    return {
      context: {
        create: _req => {
          return { photon }
        },
        typeGen: {
          imports: [{ as: 'Photon', from: GENERATED_PHOTON_OUTPUT_PATH }],
          fields: {
            photon: 'Photon.Photon',
          },
        },
      },
      nexus: {
        plugins: [
          nexusPrismaPlugin({
            inputs: {
              photon: GENERATED_PHOTON_OUTPUT_PATH,
            },
            outputs: {
              typegen: nexusPrismaTypegenOutput,
            },
            shouldGenerateArtifacts: shouldGenerateArtifacts(),
            onUnknownFieldName: params => renderUnknownFieldNameError(params),
            onUnknownFieldType: params => renderUnknownFieldTypeError(params),
          } as OptionsWithHook),
        ],
      },
    }
  })

  /**
   * Execute all the generators in the user's PSL file.
   */
  async function runPrismaGenerators(
    options: { silent: boolean } = { silent: false }
  ): Promise<void> {
    const schemaPath = await maybeFindPrismaSchema()

    if (!schemaPath) {
      throw new Error('please create a prisma file')
    }

    // TODO Do not assume that just because photon does not need to be regenerated that no other generators do
    if ((await shouldRegeneratePhoton(schemaPath)) === false) {
      pumpkins.utils.debug(
        'Prisma generators were not run because the prisma schema was not updated'
      )
      return
    }

    if (!options.silent) {
      pumpkins.utils.log.info('Running Prisma generators ...')
    }

    let generators = await getGenerators(schemaPath)

    if (!generators.find(g => g.options?.generator.provider === 'photonjs')) {
      await scaffoldPhotonGeneratorBlock(schemaPath)
      // TODO: Generate it programmatically instead for performance reason
      generators = await getGenerators(schemaPath)
    }

    for (const g of generators) {
      const resolvedSettings = getGeneratorResolvedSettings(g)

      pumpkins.utils.debug(
        'generating %s instance %s to %s',
        resolvedSettings.name,
        resolvedSettings.instanceName,
        resolvedSettings.output
      )

      await g.generate()
      g.stop()
    }
  }

  /**
   * Find the PSL file in the project. If multiple are found a warning is logged.
   */
  async function maybeFindPrismaSchema(): Promise<null | string> {
    // TODO ...base ignores from pumpkins... pumpkins.fs.findAsync?
    const schemaPaths = await fs.findAsync({
      matching: [
        'schema.prisma',
        '!prisma/migrations/**/*',
        '!node_modules/**/*',
      ],
    })

    if (schemaPaths.length > 1) {
      pumpkins.utils.log.warn(
        `We found multiple "schema.prisma" files in your project.\n${schemaPaths
          .map((p, i) => `- "${p}"${i === 0 ? ' (used by pumpkins)' : ''}`)
          .join('\n')}`
      )
    }

    return schemaPaths[0] ?? null
  }

  /**
   * Regenerate photon only if schema was updated between last generation
   */
  async function shouldRegeneratePhoton(
    localSchemaPath: string
  ): Promise<boolean> {
    const photonSchemaPath = path.join(
      GENERATED_PHOTON_OUTPUT_PATH,
      'schema.prisma'
    )

    pumpkins.utils.debug(
      "checking if photon needs to be regenerated by comparing users PSL to photon's local copy...\n%s\n%s",
      photonSchemaPath,
      localSchemaPath
    )

    const [photonSchema, localSchema] = await Promise.all([
      fs.readAsync(photonSchemaPath),
      fs.readAsync(localSchemaPath),
    ])

    if (photonSchema !== undefined && localSchema !== undefined) {
      pumpkins.utils.debug('...found photon and its local version of PSL')
      if (photonSchema === localSchema) {
        pumpkins.utils.debug(
          "...found that its local PSL version matches user's current, will NOT regenerate photon"
        )
        return false
      } else {
        pumpkins.utils.debug(
          "...found that its local PSL version does not match user's current, WILL regenerate photon"
        )
        return true
      }
    } else {
      pumpkins.utils.debug(
        '...did not find generated photon package or its local copy of PSL'
      )
      return true
    }
  }

  async function scaffoldPhotonGeneratorBlock(schemaPath: string) {
    const schemaPathAbs = path.relative(process.cwd(), schemaPath)
    pumpkins.utils.log.warn(
      `A PhotonJS generator block is needed in your Prisma Schema at "${schemaPathAbs}".`
    )
    pumpkins.utils.log.warn('We scaffolded one for you.')
    const schemaContent = await fs.readAsync(schemaPath)!
    const generatorBlock = stripIndent`
      generator photon {
        provider = "photonjs"
      }
    `
    await fs.writeAsync(schemaPath, `${generatorBlock}\n${schemaContent}`)
  }
})

/**
 * TODO ...
 */
function renderUnknownFieldNameError(params: UnknownFieldName) {
  const { stack, fileLineNumber } = printStack({
    callsite: params.error.stack,
  })
  const suggestions = suggestionList(
    params.unknownFieldName,
    params.validFieldNames
  ).map(s => chalk.green(s))
  const suggestionMessage =
    suggestions.length === 0
      ? ''
      : chalk`{yellow Warning:} Did you mean ${suggestions
          .map(s => `"${s}"`)
          .join(', ')} ?`
  const intro = chalk`{yellow Warning:} ${params.error.message}\n{yellow Warning:} in ${fileLineNumber}\n${suggestionMessage}`

  console.log(`${intro}${stack}`)
}

/**
 * TODO ...
 */
function renderUnknownFieldTypeError(params: UnknownFieldType) {
  const { stack, fileLineNumber } = printStack({
    callsite: params.error.stack,
  })

  const intro = chalk`{yellow Warning:} ${params.error.message}\n{yellow Warning:} in ${fileLineNumber}`

  console.log(`${intro}${stack}`)
}

// /**
//  * Check the project to find out if the user intends prisma to be enabled or
//  * not.
//  */
// export async function isPrismaEnabled(): Promise<
//   | {
//       enabled: false;
//     }
//   | {
//       enabled: true;
//       schemaPath: string;
//     }
// > {
//   const schemaPath = await maybeFindPrismaSchema();

//   if (schemaPath === null) {
//     pumpkins.utils.debug('detected that this is not prisma framework project');
//     return { enabled: false };
//   }

//   pumpkins.utils.debug('detected that this is a prisma framework project');
//   return { enabled: true, schemaPath: fs.path(schemaPath) };
// }

// export function isPrismaEnabledSync():
//   | {
//       enabled: false;
//     }
//   | {
//       enabled: true;
//       schemaPath: string;
//     } {
//   const schemaPaths = fs.find({
//     directories: false,
//     recursive: true,
//     matching: [
//       'schema.prisma',
//       '!node_modules/**/*',
//       '!prisma/migrations/**/*',
//     ],
//   });

//   if (schemaPaths.length > 1) {
//     console.warn(
//       `Warning: we found multiple "schema.prisma" files in your project.\n${schemaPaths
//         .map((p, i) => `- \"${p}\"${i === 0 ? ' (used by pumpkins)' : ''}`)
//         .join('\n')}`
//     );
//   }

//   if (schemaPaths.length === 0) {
//     pumpkins.utils.debug('detected that this is not prisma framework project');
//     return { enabled: false };
//   }

//   pumpkins.utils.debug('detected that this is a prisma framework project');
//   return { enabled: true, schemaPath: fs.path(schemaPaths[0]) };
// }

/**
 * Get the declared generator blocks in the user's PSL file
 */
async function getGenerators(schemaPath: string) {
  const aliases: Prisma.ProviderAliases = {
    photonjs: {
      // HACK (see var declaration LOC)
      outputPath: GENERATED_PHOTON_OUTPUT_PATH,
      generatorPath: require.resolve('@prisma/photon/generator-build'),
    },
  }

  return await Prisma.getGenerators({
    schemaPath,
    printDownloadProgress: false,
    providerAliases: aliases,
  })
}

/**
 * Compute the resolved settings of a generator which has its baked in manifest
 * but also user-provided overrides. This computes the merger of the two.
 */
function getGeneratorResolvedSettings(
  g: Prisma.Generator
): {
  name: string
  instanceName: string
  output: string
} {
  return {
    name: g.manifest?.prettyName ?? '',
    instanceName: g.options?.generator.name ?? '',
    output: g.options?.generator.output ?? g.manifest?.defaultOutput ?? '',
  }
}

type Database = Exclude<
  PumpkinsPlugin.OnAfterBaseSetupLens['database'],
  undefined
>
type ConnectionURI = PumpkinsPlugin.OnAfterBaseSetupLens['connectionURI']

const DATABASE_TO_PRISMA_PROVIDER: Record<
  Database,
  'sqlite' | 'postgresql' | 'mysql'
> = {
  SQLite: 'sqlite',
  MySQL: 'mysql',
  PostgreSQL: 'postgresql',
}

function renderDatasource(db: {
  database: Database
  connectionURI: ConnectionURI
}): string {
  const provider = DATABASE_TO_PRISMA_PROVIDER[db.database]

  return stripIndent`
    datasource db {
      provider = "${provider}"
      url      = env("PUMPKINS_DATABASE_URL")
    }`
}

const DATABASE_TO_CONNECTION_URI: Record<
  Database,
  (projectName: string) => string
> = {
  SQLite: _ => 'file://dev.db',
  PostgreSQL: projectName =>
    `postgresql://postgres:<password>@localhost:5432/${projectName}`,
  MySQL: projectName => `mysql://root:<password>@localhost:3306/${projectName}`,
}

function renderConnectionURI(
  db: {
    database: Database
    connectionURI: ConnectionURI
  },
  layout: Layout
): string {
  if (db.connectionURI) {
    return db.connectionURI
  }

  return DATABASE_TO_CONNECTION_URI[db.database](layout.project.name)
}

function handleLiftResponse(
  pumpkins: PumpkinsPlugin.Lens,
  response: SuccessfulRunResult,
  message: string
): boolean {
  if (response.error || response.stderr) {
    pumpkins.utils.log.error(message)

    if (response.stderr) {
      pumpkins.utils.log.error(response.stderr)
    } else if (response.error?.stack) {
      pumpkins.utils.log.error(response.error.stack)
    }
    return false
  }

  // HACK TODO: replace lift logs with pumpkins logs....
  if (response.stdout) {
    console.log(
      response.stdout
        .replace('Lift', 'Pumpkins')
        .replace('prisma2 lift up', 'pumpkins db migrate apply')
    )
  }

  return true
}
