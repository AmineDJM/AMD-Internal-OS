/**
 * LE DÉCOR DU BC DEPUIS UN DEVIS POUR L'E2E (lot B1, décision 0049) — sous `tsx`, avec le code de PRODUCTION.
 *
 *   seed <email>    dépose au Drive de la personne le devis INSIGNE fabriqué (vrai PDF, 27 lignes, 3 pages), prépare
 *                   la carte comme l'assistant le fait à « Crée un bc en pdf » (outil réel `preparer_bc_depuis_devis`,
 *                   SANS validateur ni société), et la pose dans le fil de la personne ;
 *   clean <email>   retire les BC, fichiers, intentions, lectures et tours semés.
 *
 * Aucun appel de modèle : le tableau du devis se lit par ses positions (il réconcilie au HT imprimé).
 */

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { putBlob } from "@/lib/drive-storage";
import { enregistrerFichierDrive } from "@/lib/drive/depot";
import { DEVIS_INSIGNE, fichierDuDevis } from "@/lib/pieces-lues/banc/devis-fabriques";
import { outilsV1, type PropositionPreparee } from "@/modules/assistant-ia/api";

const MARQUE = "__e2e__b1";

async function personne(email: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: null, access, mustChangePassword: false } as CurrentUser;
}

async function nettoyer(user: CurrentUser): Promise<void> {
  const bcs = await prisma.legalDocument.findMany({ where: { createdById: user.id, kind: "PURCHASE_ORDER", counterparty: "INSIGNE" }, select: { id: true } });
  await prisma.documentReference.deleteMany({ where: { entityId: { in: bcs.map((b) => b.id) } } }).catch(() => {});
  await prisma.legalDocument.deleteMany({ where: { id: { in: bcs.map((b) => b.id) } } });
  await prisma.companyContact.deleteMany({ where: { name: "INSIGNE", createdById: user.id } });
  const noeuds = await prisma.driveNode.findMany({ where: { ownerId: user.id, OR: [{ name: { startsWith: MARQUE } }, { name: { contains: "INSIGNE" } }] }, select: { id: true } });
  await prisma.fileVersion.deleteMany({ where: { nodeId: { in: noeuds.map((n) => n.id) } } });
  await prisma.driveNode.deleteMany({ where: { id: { in: noeuds.map((n) => n.id) } } });
  await prisma.assistantActionIntent.deleteMany({ where: { userId: user.id, title: { startsWith: "Bon de commande — INSIGNE" } } });
  await prisma.assistantIaTour.deleteMany({ where: { userId: user.id, contenu: { contains: MARQUE } } });
}

async function main(): Promise<void> {
  const [cmd, email] = process.argv.slice(2);
  if (!email) throw new Error("usage : carte-bc-devis.ts seed|clean <email>");
  const user = await personne(email);
  await nettoyer(user);
  if (cmd !== "seed") return;

  const { blobId, size } = await putBlob(await fichierDuDevis(DEVIS_INSIGNE));
  const devis = await enregistrerFichierDrive(user, { nodeId: null, parentId: null, spaceId: null, category: null, viewers: [], editors: [] },
    { blobId, size, mimeType: "application/pdf", name: `${MARQUE} ${DEVIS_INSIGNE.fichier}` });
  const props: PropositionPreparee[] = [];
  const outil = outilsV1(user, props, [], [], null, undefined, { capacites: true }).find((t) => t.def.name === "preparer_bc_depuis_devis");
  if (!outil) throw new Error("opération preparer_bc_depuis_devis absente");
  const sortie = await outil.run({ fichier: devis.id }, user);
  const p = props[0];
  if (!p) throw new Error(`aucune carte : ${sortie}`);
  const courante = await prisma.assistantIaFil.findFirst({ where: { userId: user.id, archiveLe: null, prive: false }, orderBy: { dernierLe: "desc" } });
  const fil = courante
    ? await prisma.assistantIaFil.update({ where: { id: courante.id }, data: { dernierLe: new Date() } })
    : await prisma.assistantIaFil.create({ data: { userId: user.id } });
  const question = await prisma.assistantIaTour.create({
    data: { filId: fil.id, userId: user.id, role: "user", contenu: `${MARQUE} Crée un bc en pdf`, etat: "TRAITE" },
  });
  await prisma.assistantIaTour.create({
    data: {
      filId: fil.id, userId: user.id, role: "assistant", etat: "TERMINE", repondA: question.id,
      contenu: `${MARQUE} Voici le bon de commande composé depuis le devis INSIGNE : 27 lignes, 794 500 DZD HT. Créez-le pour obtenir son PDF.`,
      intent: {
        id: p.intentId, kind: p.proposition.kind, title: p.proposition.title, fields: p.proposition.fields,
        warnings: p.proposition.warnings, libelleBouton: (p.proposition as { libelleBouton?: string }).libelleBouton, status: "PROPOSED",
      } as object,
    },
  });
  console.log(p.intentId);
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
