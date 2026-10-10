-- Ejecutar una sola vez sobre la rama de prueba después de respaldar si se desea conservar datos antiguos.
-- El padrón y las alineaciones dejan de formar parte de la aplicación.
ALTER TABLE "Partido" DROP COLUMN IF EXISTS "convocadosLocal";
ALTER TABLE "Partido" DROP COLUMN IF EXISTS "convocadosVisita";
DROP TABLE IF EXISTS "Jugador";
