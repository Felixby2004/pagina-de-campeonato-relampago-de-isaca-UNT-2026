import 'dotenv/config';
import { PrismaClient } from '../node_modules/.prisma/mesa-client-v2/index.js';

const prisma = new PrismaClient();
const equipos = Array.from({ length: 32 }, (_, index) => {
  const numero = String(index + 1).padStart(2, '0');
  return {
    nombre: `Equipo Demo ${numero}`,
    delegado: `Delegado Demo ${numero}`,
  };
});

async function main() {
  if (process.env.ALLOW_DEMO_TEAMS_SEED !== 'YES') {
    throw new Error('Seed protegido: define ALLOW_DEMO_TEAMS_SEED=YES solo para una base de pruebas.');
  }
  const existing = await prisma.equipo.count();
  if (existing !== 0) {
    throw new Error(`La base ya contiene ${existing} equipos. El seed demo solo funciona si no hay equipos.`);
  }
  await prisma.equipo.createMany({ data: equipos });
  console.log('Creados 32 equipos demo; los documentos se gestionan fuera de la web.');
}

main()
  .catch((error) => {
    console.error('No se pudo cargar el seed demo:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
