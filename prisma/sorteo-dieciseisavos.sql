-- Sorteo único de Dieciseisavos (32 equipos activos, 16 cruces).
-- Este archivo NO se ejecuta automáticamente al iniciar la aplicación ni con db:push.
-- Ejecútalo manualmente desde Neon SQL Editor únicamente cuando quieras sortear.
-- Los 16 partidos quedan programados el 10/10/2026 desde las 08:00 (hora de Lima).
-- Se programan cuatro partidos simultáneos, uno por cancha, cada 27 minutos.
-- Si ya existen los 16 cruces, una nueva ejecución no cambia ni vuelve a sortearlos.

DO $$
DECLARE
  partidos_existentes integer;
  equipos_disponibles integer;
BEGIN
  -- Evita que dos ejecuciones simultáneas creen dos sorteos.
  PERFORM pg_advisory_xact_lock(21851032);

  SELECT count(*) INTO partidos_existentes
  FROM "Partido"
  WHERE "fase" = 'RONDA_32'::"FaseTorneo";

  IF partidos_existentes = 16 THEN
    RAISE NOTICE 'Dieciseisavos ya sorteados: se mantienen los cruces existentes.';
    RETURN;
  ELSIF partidos_existentes > 0 THEN
    RAISE EXCEPTION 'Hay % cruces parciales de Dieciseisavos. No se modificó nada; revísalos antes de continuar.', partidos_existentes;
  END IF;

  -- Este script está pensado para ejecutarse antes de crear partidos de otras fases.
  IF EXISTS (SELECT 1 FROM "Partido") THEN
    RAISE EXCEPTION 'Ya existen partidos en el torneo. No se creó otro sorteo.';
  END IF;

  SELECT count(*) INTO equipos_disponibles
  FROM "Equipo"
  WHERE "activo" = true AND "eliminado" = false;

  IF equipos_disponibles <> 32 THEN
    RAISE EXCEPTION 'Se necesitan exactamente 32 equipos activos y no eliminados; actualmente hay %.', equipos_disponibles;
  END IF;

  WITH equipos_ordenados AS (
    SELECT
      "id",
      "nombre",
      row_number() OVER (ORDER BY random(), "id") AS posicion
    FROM "Equipo"
    WHERE "activo" = true AND "eliminado" = false
  ), cruces AS (
    SELECT
      ((posicion + 1) / 2)::integer AS numero,
      max("id") FILTER (WHERE posicion % 2 = 1) AS local_id,
      max("nombre") FILTER (WHERE posicion % 2 = 1) AS local_nombre,
      max("id") FILTER (WHERE posicion % 2 = 0) AS visita_id,
      max("nombre") FILTER (WHERE posicion % 2 = 0) AS visita_nombre
    FROM equipos_ordenados
    GROUP BY ((posicion + 1) / 2)::integer
  )
  INSERT INTO "Partido" (
    "id", "cancha", "equipoLocal", "equipoVisita", "numeroEnFase",
    "equipoLocalId", "equipoVisitaId", "fase", "estado",
    "periodoActual", "esWO", "penalesLocal", "penalesVisita",
    "penalesHechosLocal", "penalesHechosVisita", "golesLocal", "golesVisita",
    "minutoActual", "relojSegundos", "relojIniciadoEn", "horaInicio", "programadoPara", "actualizadoEn"
  )
  SELECT
    'c' || substr(md5(random()::text || clock_timestamp()::text || numero::text), 1, 24),
    ((numero - 1) % 4 + 1)::integer, -- distribuye cuatro cruces por cancha
    local_nombre,
    visita_nombre,
    numero,
    local_id,
    visita_id,
    'RONDA_32'::"FaseTorneo",
    'POR_INICIAR'::"EstadoPartido",
    1,
    false,
    0, 0, 0, 0, 0, 0,
    0, 0, NULL, NULL,
    TIMESTAMP '2026-10-10 13:00:00' + (((numero - 1) / 4) * INTERVAL '27 minutes'),
    now()
  FROM cruces
  ORDER BY numero;

  RAISE NOTICE 'Sorteo creado: 16 partidos para el 10/10/2026 desde las 08:00 (hora de Lima), en bloques de cuatro canchas cada 27 minutos.';
END $$;
