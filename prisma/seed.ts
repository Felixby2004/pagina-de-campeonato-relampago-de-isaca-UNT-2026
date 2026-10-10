import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { PrismaClient, Rol } from '../node_modules/.prisma/mesa-client-v2/index.js';

const prisma = new PrismaClient();

// 4 cuentas en total: Mesa Central también puede operar la cancha 4.
const accounts = [
  { username: 'mesa.admin', rol: Rol.ADMIN_MESA, password: process.env.SEED_ADMIN_PASSWORD || 'Mesa-ISACA-2026!' },
  { username: 'operador1', rol: Rol.PLANILLERO, password: process.env.SEED_OPERATOR1_PASSWORD || 'Operador1-ISACA-2026!' },
  { username: 'operador2', rol: Rol.PLANILLERO, password: process.env.SEED_OPERATOR2_PASSWORD || 'Operador2-ISACA-2026!' },
  { username: 'operador3', rol: Rol.PLANILLERO, password: process.env.SEED_OPERATOR3_PASSWORD || 'Operador3-ISACA-2026!' },
];

const previousUsernames = ['veedor.c1', 'veedor.c2', 'veedor.c3'];

async function main() {
  try {
    // Conserva las cuentas ya creadas, pero quita sus antiguos nombres asociados a cancha.
    for (const [index, previousUsername] of previousUsernames.entries()) {
      const oldUser = await prisma.usuario.findUnique({ where: { username: previousUsername } });
      const replacement = accounts[index + 1];
      if (oldUser && replacement) {
        const passwordHash = await bcrypt.hash(replacement.password, 12);
        await prisma.usuario.update({ where: { id: oldUser.id }, data: { username: replacement.username, passwordHash, rol: Rol.PLANILLERO, activo: true } });
      }
    }
    for (const account of accounts) {
      const passwordHash = await bcrypt.hash(account.password, 12);
      await prisma.usuario.upsert({
        where: { username: account.username },
        update: { passwordHash, rol: account.rol, activo: true },
        create: { username: account.username, passwordHash, rol: account.rol },
      });
    }
    console.log('Seed listo: 4 cuentas creadas/actualizadas. No se cargaron partidos ficticios.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error('No se pudo cargar el seed:', error);
  process.exitCode = 1;
});
