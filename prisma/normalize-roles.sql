-- Run once in the Neon SQL Editor before `npm run db:push` when the database
-- still has the old CANCHA_* enum values. Supports both an existing Usuario
-- table and the partial state where only the old enum remains.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'Rol' AND e.enumlabel LIKE 'CANCHA_%'
  ) THEN
    IF to_regclass('public."Usuario"') IS NOT NULL THEN
      ALTER TABLE "Usuario" ALTER COLUMN "rol" DROP DEFAULT;
      CREATE TYPE "Rol_new" AS ENUM ('PUBLICO', 'PLANILLERO', 'ADMIN_MESA');
      ALTER TABLE "Usuario"
        ALTER COLUMN "rol" TYPE "Rol_new"
        USING (
          CASE WHEN "rol"::text LIKE 'CANCHA_%' THEN 'PLANILLERO' ELSE "rol"::text END
        )::"Rol_new";
      DROP TYPE "Rol";
      ALTER TYPE "Rol_new" RENAME TO "Rol";
      ALTER TABLE "Usuario" ALTER COLUMN "rol" SET DEFAULT 'PUBLICO'::"Rol";
    ELSE
      -- No user rows exist to preserve; replace the orphaned enum directly.
      DROP TYPE "Rol";
      CREATE TYPE "Rol" AS ENUM ('PUBLICO', 'PLANILLERO', 'ADMIN_MESA');
    END IF;
  END IF;
END $$;
