/**
 * LE DÉCOR DE L'ATELIER POUR L'E2E (J3) — sous `tsx`, avec le code de PRODUCTION (`putBlob`, fixtures, socle Atelier).
 *
 *   seed  <email>                       dépose un contrat Word et un PowerPoint dans le Drive de la personne et les
 *                                       OUVRE dans l'Atelier (ce que fait l'outil `ouvrir_dans_l_atelier`) ;
 *   geste <email> <sessionId> <json>    applique des gestes comme l'assistant (`modifier_document`) — l'écran ne
 *                                       le sait que par la relecture de `/api/assistant-ia/atelier`, comme en vrai.
 *
 * Aucun appel de modèle : c'est la règle de la suite E2E.
 */

import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { putBlob } from "@/lib/drive-storage";
import { docxDeParagraphes, pptxDiapos } from "@/lib/artifact/adapters/fixtures";
import { appliquerGestes, ouvrirDansAtelier } from "@/platform/ia/artifact/atelier/service";

const PREFIXE = "__e2e__ Atelier";

async function personne(email: string): Promise<CurrentUser> {
  const u = await prisma.user.findUniqueOrThrow({ where: { email } });
  const access = await getAccess(u.id, u.role);
  return { id: u.id, name: u.name, email: u.email, role: u.role, secondaryRole: null, access, mustChangePassword: false };
}

async function deposer(user: CurrentUser, nom: string, octets: Buffer, mime: string): Promise<string> {
  const b = await putBlob(octets);
  const n = await prisma.driveNode.create({
    data: { name: nom, type: "FILE", ownerId: user.id, createdById: user.id, mimeType: mime, size: b.size, versions: { create: { blobId: b.blobId, version: 1, size: b.size, mimeType: mime, createdById: user.id } } },
  });
  return n.id;
}

async function main(): Promise<void> {
  const [cmd, email, sessionId, json] = process.argv.slice(2);
  if (!email) throw new Error("usage : atelier.ts seed|geste <email> …");
  const user = await personne(email);
  if (cmd === "seed") {
    await prisma.artifactSession.updateMany({ where: { userId: user.id, blockId: { startsWith: "atelier-" } }, data: { state: "CLOSED" } });
    await prisma.driveNode.deleteMany({ where: { name: { startsWith: PREFIXE } } });
    const docx = await deposer(user, `${PREFIXE} Contrat Benali.docx`, await docxDeParagraphes([
      "Contrat de travail à durée indéterminée",
      "Article 1 — Engagement : M. Benali est engagé en qualité de délégué médical.",
      "Article 2 — Période d'essai : la période d'essai est de 3 mois.",
      "Article 3 — Rémunération : selon la grille en vigueur.",
    ], { premierEstTitre: true }), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    const pptx = await deposer(user, `${PREFIXE} Revue trimestrielle.pptx`, await pptxDiapos(3), "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    const a = await ouvrirDansAtelier(user, { nodeId: docx });
    const b = await ouvrirDansAtelier(user, { nodeId: pptx });
    if (!a.vue || !b.vue) throw new Error(`ouverture : ${a.motif ?? b.motif}`);
    process.stdout.write(JSON.stringify({ docx: { nodeId: docx, sessionId: a.vue.sessionId }, pptx: { nodeId: pptx, sessionId: b.vue.sessionId } }));
  } else if (cmd === "geste") {
    const r = await appliquerGestes(user, sessionId!, JSON.parse(json!), { pasMs: 0 });
    process.stdout.write(JSON.stringify({ ok: r.ok, motif: r.motif, gestes: r.gestes }));
  } else {
    throw new Error(`commande inconnue : ${cmd}`);
  }
}

main().then(() => prisma.$disconnect()).catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
