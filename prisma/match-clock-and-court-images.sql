-- Cambios para el reloj configurable por partido e imágenes por cancha.
-- Ejecutar en la base local o en Neon solo cuando decidas actualizar el esquema.
ALTER TABLE "Partido"
  ADD COLUMN IF NOT EXISTS "duracionPrimerTiempo" INTEGER NOT NULL DEFAULT 600,
  ADD COLUMN IF NOT EXISTS "duracionSegundoTiempo" INTEGER NOT NULL DEFAULT 600,
  ADD COLUMN IF NOT EXISTS "primerTiempoTranscurrido" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "numeroEnFase" INTEGER NOT NULL DEFAULT 1;

-- Asigna un orden estable a partidos ya existentes para conservar los cruces del bracket.
WITH numerados AS (
  SELECT "id", row_number() OVER (PARTITION BY "fase" ORDER BY "programadoPara" NULLS LAST, "cancha", "id") AS numero
  FROM "Partido"
)
UPDATE "Partido" AS p SET "numeroEnFase" = n.numero::integer
FROM numerados AS n
WHERE p."id" = n."id"
  AND EXISTS (
    SELECT 1 FROM "Partido" AS other
    WHERE other."fase" = p."fase"
    GROUP BY other."fase"
    HAVING count(DISTINCT other."numeroEnFase") < count(*)
  );

CREATE TABLE IF NOT EXISTS "ImagenCancha" (
  "cancha" INTEGER NOT NULL,
  "url" TEXT,
  "actualizadoEn" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ImagenCancha_pkey" PRIMARY KEY ("cancha"),
  CONSTRAINT "ImagenCancha_cancha_check" CHECK ("cancha" BETWEEN 1 AND 4)
);
