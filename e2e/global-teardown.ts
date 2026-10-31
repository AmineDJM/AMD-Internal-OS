import { PrismaClient } from "@prisma/client";

/** Retire TOUT le seed E2E (préfixe __e2e__) — la base ressort comme elle est entrée. */
export default async function globalTeardown(): Promise<void> {
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/amd_internal_os?schema=public" } },
  });
  try {
    await prisma.userInvite.deleteMany({ where: { token: { startsWith: "__e2e__" } } });
    await prisma.feedbackAttachment.deleteMany({ where: { feedback: { message: { startsWith: "__e2e__" } } } }).catch(() => {});
    await prisma.feedback.deleteMany({ where: { message: { startsWith: "__e2e__" } } }).catch(() => {});
    await prisma.executiveCommitment.deleteMany({ where: { who: { startsWith: "__e2e__" } } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { title: { startsWith: "__e2e__" } } }).catch(() => {});
    await prisma.validationRequest.deleteMany({ where: { reference: { startsWith: "__e2e__" } } }).catch(() => {});
    await prisma.legalDocument.deleteMany({ where: { title: { startsWith: "__e2e__" } } }).catch(() => {});
    await prisma.legalFolder.deleteMany({ where: { name: { startsWith: "__e2e__" } } }).catch(() => {});
    await prisma.auditLog.deleteMany({ where: { actor: { email: { startsWith: "__e2e__" } } } }).catch(() => {});
    // Le décor Live Office : les nœuds Drive puis leurs versions partent en cascade avec le
    // propriétaire ; on retire d'abord les nœuds nommés, pour le cas où le testeur survivrait.
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: "__e2e__" } } }).catch(() => {});
    // J11 : les dépôts de dossier du banc (leur racine porte le préfixe, retirée juste au-dessus).
    await prisma.assistantIaDepotDossier.deleteMany({ where: { nom: { startsWith: "__e2e__" } } }).catch(() => {});
    await prisma.artifactSession.deleteMany({ where: { name: { startsWith: "__e2e__" } } }).catch(() => {});
    await prisma.assistantProvenance.deleteMany({ where: { question: { startsWith: "__e2e__" } } }).catch(() => {});
    // LE COACHING (§118.157) : une version de grille publiée par un compte de banc SURVIVRAIT à
    // son auteur (`SetNull`) et deviendrait la grille EN VIGUEUR de toute la base. Les fiches
    // d'abord (elles tiennent leur version par une clé `Restrict`), puis les versions.
    await prisma.coachingSheet.deleteMany({
      where: { OR: [{ collaborator: { email: { startsWith: "__e2e__" } } }, { createdBy: { email: { startsWith: "__e2e__" } } }] },
    });
    await prisma.coachingGrid.deleteMany({ where: { createdBy: { email: { startsWith: "__e2e__" } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: "__e2e__" } } });
  } finally {
    await prisma.$disconnect();
  }
}
