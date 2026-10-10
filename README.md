# Torneo Relámpago ISACA UNT

Aplicación local para torneo de eliminación directa con cuatro canchas. El público entra por `/`; el personal inicia sesión en `/login`.

## Estructura

- `apps/web`: React, Vite y Tailwind; marcador público, fixture y paneles.
- `apps/api`: Express, REST y Prisma.
- `prisma`: esquema PostgreSQL, seed y utilidades de base de datos.

## Desarrollo local

1. Copia `.env.example` a `.env` y configura `DATABASE_URL`, `DIRECT_URL` y `JWT_SECRET`.
2. Ejecuta `npm install`, `npm run db:generate` y `npm run db:push`.
3. Ejecuta `npm run db:seed` para crear las cuatro cuentas operativas iniciales; sus credenciales están documentadas en `.env.example`.
4. Ejecuta `npm run dev`: interfaz en `http://localhost:5173` y API en `http://localhost:3000`.

El seed no crea equipos ni resultados ficticios. Un `PLANILLERO` puede operar cualquier cancha; `ADMIN_MESA` también gestiona equipos y fixture. En el panel de admin se registran los 32 equipos y luego se cargan manualmente los 16 cruces de Dieciseisavos, con cancha y horario. La sincronización de Prisma debe ejecutarse manualmente en la base configurada; este código no modifica Neon por su cuenta.

## Criterios funcionales

- Eliminación directa: dieciseisavos, octavos, cuartos, semifinales, tercer puesto y final. No hay tabla de posiciones ni tabla pública de goleadores.
- En la web cada equipo guarda únicamente nombre y delegado. Las inscripciones, documentos y alineaciones se verifican en físico; no se almacenan jugadores ni convocatorias. Los nombres de jugador en incidencias son parte del acta del partido.
- Fases regulares: dos tiempos de 10 minutos y 5 de descanso; semifinal/final: dos de 15. Empate: tres penales cada equipo y luego muerte súbita.
- W.O. cuando se cumple la tolerancia de 10 minutos; gana el equipo presente y finaliza el partido.
- Las incidencias se pueden corregir o eliminar antes de enviar el acta. El envío publica el resultado y bloquea la edición.
- La vista pública se actualiza por polling cada cuatro segundos. Vercel Functions no mantienen conexiones WebSocket persistentes.

Las bases describen además inscripción y pago, controles documentales presenciales, reclamos formales y decisiones de comisiones. La web no procesa pagos ni sustituye esos procedimientos oficiales.

## Equipos de prueba

Para una base de datos de pruebas vacía, el seed opcional `npm run db:seed:teams-demo` crea `Equipo Demo 01` a `Equipo Demo 32`, con un delegado ficticio por equipo. No crea jugadores ni partidos. Por seguridad, exige habilitación explícita y se detiene si ya existe algún equipo.

En PowerShell, luego de configurar `.env` para apuntar a tu base local/de pruebas:

```powershell
$env:ALLOW_DEMO_TEAMS_SEED = "YES"
npm run db:seed:teams-demo
Remove-Item Env:ALLOW_DEMO_TEAMS_SEED
```

No ejecutes este seed contra la base real del torneo. Para preparar una prueba desde cero, la tabla de equipos debe estar vacía.

Para una base ya creada, `prisma/remove-player-rosters.sql` elimina la tabla `Jugador` y las columnas de alineación en `Partido`. Es una limpieza destructiva de los datos antiguos del padrón y las convocatorias; respalda la base antes de ejecutar el SQL o confirmar el aviso de pérdida de datos de `npm run db:push`. No se ha aplicado contra Neon automáticamente.
