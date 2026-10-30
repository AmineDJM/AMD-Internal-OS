/**
 * ESSAI RÉEL DES CAPACITÉS (lot J6, décision 0020) — un tour court, par le chemin du produit (`jouerTour`), au vrai modèle.
 *
 * Ce qu'il vérifie : sur une demande d'écriture qu'aucun outil du module ne porte (« crée une tâche pour X »), le modèle
 * trouve la CAPACITÉ dérivée du contrat (présélection ou `trouver_outil`), la remplit, et le tour rend une CARTE
 * `assistant_ia_capacite` — rien n'est créé. Base LOCALE seulement (`BENCH_DATABASE_URL`), comptes synthétiques effacés à la
 * fin ; un seul tour (≈ 0,05 $).
 *
 *   npm run bench:live -- scripts/bench/capacites-essai.ts
 */
import { prisma } from "@/lib/prisma";
import { getAccess } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { jouerTour } from "@/modules/assistant-ia/api";

const TAG = `__essai_cap_${Date.now().toString(36)}_`;

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("Base locale seulement.");
  const u = await prisma.user.create({ data: { name: `Admin ${TAG}`, email: `${TAG}sa@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
  const k = await prisma.user.create({ data: { name: `Karim Essai${TAG}`, email: `${TAG}k@t.dz`, passwordHash: "x", role: "VIEWER" } });
  try {
    const access = await getAccess(u.id, u.role);
    const user = { id: u.id, name: u.name, email: u.email, role: access.role ?? u.role, secondaryRole: access.secondaryRole, access, mustChangePassword: false } as CurrentUser;
    const t0 = Date.now();
    const r = await jouerTour(user, { texte: `Crée une tâche pour Karim Essai${TAG} : préparer le stand du congrès, échéance le 6 novembre 2026.`, pieces: [], historique: [] });
    const ms = Date.now() - t0;
    const appels = await prisma.modelCallLog.findMany({ where: { userId: u.id }, select: { inputTokens: true, outputTokens: true, costUsd: true } });
    const intent = r.ok ? r.intent : null;
    console.info(JSON.stringify({
      ok: r.ok, ms, texte: r.ok ? r.content.slice(0, 300) : r.error, outils: r.ok ? r.outilsAppeles : [],
      carte: intent ? { kind: intent.kind, titre: intent.title, champs: intent.fields } : null,
      appels: appels.length, entree: appels.reduce((s, a) => s + (a.inputTokens ?? 0), 0), sortie: appels.reduce((s, a) => s + (a.outputTokens ?? 0), 0),
      coutUsd: appels.reduce((s, a) => s + Number(a.costUsd ?? 0), 0),
      tachesCreees: await prisma.task.count({ where: { title: { contains: "stand du congrès" }, createdById: u.id } }),
    }, null, 2));
  } finally {
    await prisma.assistantActionIntent.deleteMany({ where: { userId: u.id } }).catch(() => {});
    await prisma.modelCallLog.deleteMany({ where: { userId: u.id } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
