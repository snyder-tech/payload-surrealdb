import type { CreateMigration, MigrationTemplateArgs } from 'payload'

import { getPredefinedMigration, writeMigrationIndex } from 'payload'

const migrationTemplate = ({
  downSQL,
  imports,
  upSQL,
}: MigrationTemplateArgs): string => `import type { MigrateDownArgs, MigrateUpArgs } from '@snyder-tech/payload-surrealdb'
${imports ?? ''}
export async function up({ payload, req, session }: MigrateUpArgs): Promise<void> {
${upSQL ?? `  // Migration code`}
}

export async function down({ payload, req, session }: MigrateDownArgs): Promise<void> {
${downSQL ?? `  // Migration code`}
}
`

export const createMigration: CreateMigration = async function createMigration({
  file,
  migrationName,
  payload,
  skipEmpty,
}) {
  // Loaded here and not at the top of the module: these are Node-only, and the adapter's entry
  // point is bundled for Cloudflare Workers.
  const [{ default: fs }, { default: path }, { fileURLToPath }] = await Promise.all([
    import('node:fs'),
    import('node:path'),
    import('node:url'),
  ])

  const dirname = path.dirname(fileURLToPath(import.meta.url))
  const dir = payload.db.migrationDir

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }

  const predefinedMigration = await getPredefinedMigration({
    dirname,
    payload,
    ...(file !== undefined && { file }),
    ...(migrationName !== undefined && { migrationName }),
  })

  const migrationFileContent = migrationTemplate(predefinedMigration)

  // `20260102_030405`, so migration files sort by creation time
  const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '_')

  const formattedName = migrationName?.replace(/\W/g, '_')
  const fileName = migrationName ? `${timestamp}_${formattedName}.ts` : `${timestamp}_migration.ts`
  const filePath = `${dir}/${fileName}`

  if (skipEmpty) {
    return { created: false }
  }

  fs.writeFileSync(filePath, migrationFileContent)

  writeMigrationIndex({ migrationsDir: payload.db.migrationDir })

  payload.logger.info({ msg: `Migration created at ${filePath}` })

  return { created: true, path: filePath }
}
