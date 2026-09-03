import 'dotenv/config';

import { PrismaClient } from '@prisma/client';

import { hashPassword } from '../src/services/password.service.js';

if (process.env.NODE_ENV === 'production') {
  throw new Error('El seed de demostración no puede ejecutarse en producción.');
}

const prisma = new PrismaClient();
const asDate = (isoDate) => new Date(`${isoDate}T00:00:00.000Z`);
const demoPassword = 'Demo-password-1!';

const ids = Object.freeze({
  user: '00000000-0000-4000-8000-000000000001',
  household: '00000000-0000-4000-8000-000000000002',
  access: '00000000-0000-4000-8000-000000000003',
  personA: '00000000-0000-4000-8000-000000000004',
  personB: '00000000-0000-4000-8000-000000000005',
});

const categorySeeds = [
  ['Vivienda', 'vivienda', 'House', '#4F6F62'],
  ['Comunidad', 'comunidad', 'Building2', '#68766F'],
  ['Agua', 'agua', 'Droplets', '#397A91'],
  ['Luz', 'luz', 'Zap', '#A56A25'],
  ['Gas', 'gas', 'Flame', '#A14F3C'],
  ['Supermercado', 'supermercado', 'ShoppingBasket', '#347055'],
  ['Vehículos', 'vehiculos', 'Car', '#536B84'],
  ['Seguros', 'seguros', 'ShieldCheck', '#5E6285'],
  ['Suscripciones', 'suscripciones', 'RefreshCw', '#725C8D'],
  ['Tecnología', 'tecnologia', 'Laptop', '#3C687B'],
  ['Salud', 'salud', 'HeartPulse', '#9B4E5B'],
  ['Educación', 'educacion', 'GraduationCap', '#6B5D3D'],
  ['Ocio', 'ocio', 'PartyPopper', '#875979'],
  ['Mascotas', 'mascotas', 'PawPrint', '#806246'],
  ['Impuestos', 'impuestos', 'Landmark', '#6D5B57'],
  ['Servicios', 'servicios', 'Wrench', '#536C68'],
  ['Otros', 'otros', 'Shapes', '#66706B'],
];

const categoryId = (slug) => {
  const position = categorySeeds.findIndex((entry) => entry[1] === slug) + 1;
  return `10000000-0000-4000-8000-${String(position).padStart(12, '0')}`;
};

async function seed() {
  const demoPasswordHash = await hashPassword(demoPassword, 10);

  await prisma.$transaction(async (tx) => {
    await tx.user.upsert({
      where: { id: ids.user },
      update: {
        email: 'demo.owner@budgetapp.local',
        name: 'Persona A',
        passwordHash: demoPasswordHash,
        emailVerifiedAt: new Date(),
      },
      create: {
        id: ids.user,
        email: 'demo.owner@budgetapp.local',
        name: 'Persona A',
        passwordHash: demoPasswordHash,
        emailVerifiedAt: new Date(),
      },
    });

    await tx.household.upsert({
      where: { id: ids.household },
      update: {
        name: 'Casa Demo',
        currentBalanceCents: 135000,
      },
      create: {
        id: ids.household,
        ownerUserId: ids.user,
        name: 'Casa Demo',
        currentBalanceCents: 135000,
      },
    });

    await tx.householdUserAccess.upsert({
      where: {
        householdId_userId: {
          householdId: ids.household,
          userId: ids.user,
        },
      },
      update: { isActive: true, role: 'OWNER', revokedAt: null },
      create: {
        id: ids.access,
        householdId: ids.household,
        userId: ids.user,
        role: 'OWNER',
      },
    });

    await tx.householdPerson.upsert({
      where: { id: ids.personA },
      update: { contributionBps: 5000, isActive: true },
      create: {
        id: ids.personA,
        householdId: ids.household,
        linkedUserId: ids.user,
        name: 'Persona A',
        email: 'demo.owner@budgetapp.local',
        contributionBps: 5000,
      },
    });

    await tx.householdPerson.upsert({
      where: { id: ids.personB },
      update: { contributionBps: 5000, isActive: true },
      create: {
        id: ids.personB,
        householdId: ids.household,
        name: 'Persona B',
        contributionBps: 5000,
      },
    });

    for (const [name, slug, icon, color] of categorySeeds) {
      await tx.category.upsert({
        where: {
          householdId_slug: { householdId: ids.household, slug },
        },
        update: { name, icon, color, archivedAt: null },
        create: {
          id: categoryId(slug),
          householdId: ids.household,
          name,
          slug,
          icon,
          color,
          isDefault: true,
        },
      });
    }

    const recurringExpenses = [
      {
        id: '20000000-0000-4000-8000-000000000001',
        name: 'Seguro coche',
        categoryId: categoryId('seguros'),
        amountCents: 90499,
        frequency: 'YEARLY',
        startDate: asDate('2025-11-02'),
        nextDueDate: asDate('2026-11-02'),
      },
      {
        id: '20000000-0000-4000-8000-000000000002',
        name: 'Seguro vivienda',
        categoryId: categoryId('seguros'),
        amountCents: 36000,
        frequency: 'YEARLY',
        startDate: asDate('2026-01-15'),
        nextDueDate: asDate('2027-01-15'),
      },
      {
        id: '20000000-0000-4000-8000-000000000003',
        name: 'Servidor',
        categoryId: categoryId('tecnologia'),
        amountCents: 1800,
        frequency: 'MONTHLY',
        startDate: asDate('2026-01-05'),
        nextDueDate: asDate('2026-09-05'),
      },
      {
        id: '20000000-0000-4000-8000-000000000004',
        name: 'Gimnasio personal',
        categoryId: categoryId('salud'),
        personalPersonId: ids.personA,
        amountCents: 3500,
        scope: 'PERSONAL',
        frequency: 'MONTHLY',
        startDate: asDate('2026-01-03'),
        nextDueDate: asDate('2026-09-03'),
      },
    ];

    for (const expense of recurringExpenses) {
      await tx.recurringExpense.upsert({
        where: { id: expense.id },
        update: expense,
        create: {
          householdId: ids.household,
          scope: 'HOUSEHOLD',
          ...expense,
        },
      });
    }

    const invoices = [
      {
        id: '30000000-0000-4000-8000-000000000001',
        categoryId: categoryId('luz'),
        amountCents: 10500,
        periodStart: asDate('2026-02-01'),
        periodEnd: asDate('2026-03-15'),
        invoiceDate: asDate('2026-03-18'),
        chargeDate: asDate('2026-03-25'),
      },
      {
        id: '30000000-0000-4000-8000-000000000002',
        categoryId: categoryId('gas'),
        amountCents: 8600,
        periodStart: asDate('2026-01-10'),
        periodEnd: asDate('2026-03-09'),
        invoiceDate: asDate('2026-03-12'),
        chargeDate: asDate('2026-03-20'),
      },
    ];

    for (const invoice of invoices) {
      await tx.utilityInvoice.upsert({
        where: { id: invoice.id },
        update: invoice,
        create: { householdId: ids.household, ...invoice },
      });
    }

    await tx.variableExpenseMonth.upsert({
      where: {
        householdId_categoryId_ownerKey_year_month: {
          householdId: ids.household,
          categoryId: categoryId('supermercado'),
          ownerKey: 'HOUSEHOLD',
          year: 2026,
          month: 8,
        },
      },
      update: {
        entryMode: 'SUMMARY',
        summaryAmountCents: 42315,
        isComplete: true,
      },
      create: {
        id: '40000000-0000-4000-8000-000000000001',
        householdId: ids.household,
        categoryId: categoryId('supermercado'),
        ownerKey: 'HOUSEHOLD',
        scope: 'HOUSEHOLD',
        year: 2026,
        month: 8,
        entryMode: 'SUMMARY',
        summaryAmountCents: 42315,
        isComplete: true,
      },
    });
  });
}

try {
  await seed();
  process.stdout.write('Seed completado: Casa Demo con datos ficticios.\n');
} catch (error) {
  process.stderr.write(
    `No se pudo completar el seed (${error?.name ?? 'Error'}).\n`,
  );
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
