/**
 * ESSAI RÉEL DE LA SIMULATION (lot J7, décision 0029) — un tour court, par le chemin du produit (`jouerTour`), au vrai modèle.
 *
 * Ce qu'il vérifie, de bout en bout : la demande « crée une tâche pour Karim » rend une CARTE dont la simulation (transaction
 * annulée) dit ce qui serait écrit — et rien n'est créé ; la confirmation (simulation rejouée, empreinte comparée) exécute
 * l'action sous le JOURNAL DES EFFETS ; « Annuler » défait le geste, effet par effet. Base LOCALE de banc seulement,
 * comptes synthétiques effacés à la fin ; un seul tour du modèle (≈ 0,03 $).
 *
 *   npm run bench:live -- scripts/bench/simulation-essai.ts
 */
import "@/lib/async-local-storage-global";
import { prisma } from "@/lib/prisma";
import { personneDuGeste, executerHorsRequete, annulerGeste } from "@/lib/contexte-geste";
import { accesAssistantIa, executerCapacite, jouerTour } from "@/modules/assistant-ia/api";

const TAG = `__essai_sim_${Date.now().toString(36)}_`;

async function main(): Promise<void> {
  if (!/localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL ?? "")) throw new Error("Base locale seulement.");
  const u = await prisma.user.create({ data: { name: `Admin ${TAG}`, email: `${TAG}sa@t.dz`, passwordHash: "x", role: "SUPER_ADMIN" } });
  await prisma.user.create({ data: { name: `Karim Essai${TAG}`, email: `${TAG}k@t.dz`, passwordHash: "x", role: "VIEWER" } });
  try {
    const user = (await personneDuGeste(u.id))!;
    const t0 = Date.now();
    const r = await jouerTour(user, { texte: `Crée une tâche pour Karim Essai${TAG} : préparer le stand du congrès, échéance le 6 novembre 2026.`, pieces: [], historique: [] });
    const ms = Date.now() - t0;
    const appels = await prisma.modelCallLog.findMany({ where: { userId: u.id }, select: { inputTokens: true, outputTokens: true, costUsd: true } });
    const intent = r.ok ? r.intent : null;
    const avant = await prisma.task.count({ where: { createdById: u.id } });
    let confirmation: unknown = null;
    let annulation: unknown = null;
    if (intent) {
      const stocke = await prisma.assistantActionIntent.findUniqueOrThrow({ where: { id: intent.id } });
      const acces = await accesAssistantIa(user);
      confirmation = (await executerHorsRequete(user, "essai", () => executerCapacite(user, stocke.payload, acces, intent.id))).resultat;
      const g = await prisma.assistantGesteJournal.findFirst({ where: { principalId: u.id }, orderBy: { creeLe: "desc" } });
      if (g) annulation = await annulerGeste(g.id, user);
    }
    console.info(JSON.stringify({
      ok: r.ok, ms, texte: r.ok ? r.content.slice(0, 300) : r.error,
      carte: intent ? { kind: intent.kind, titre: intent.title, champs: intent.fields, simulation: intent.simulation?.resume ?? null } : null,
      tachesAvantConfirmation: avant, confirmation,
      annulation: annulation && typeof annulation === "object" && "resume" in annulation ? (annulation as { resume: string }).resume : annulation,
      tachesApresAnnulation: await prisma.task.count({ where: { createdById: u.id } }),
      appels: appels.length, entree: appels.reduce((s, a) => s + (a.inputTokens ?? 0), 0), sortie: appels.reduce((s, a) => s + (a.outputTokens ?? 0), 0),
      coutUsd: appels.reduce((s, a) => s + Number(a.costUsd ?? 0), 0),
    }, null, 2));
  } finally {
    await prisma.assistantGesteJournal.deleteMany({ where: { principalId: u.id } }).catch(() => {});
    await prisma.assistantActionIntent.deleteMany({ where: { userId: u.id } }).catch(() => {});
    await prisma.modelCallLog.deleteMany({ where: { userId: u.id } }).catch(() => {});
    await prisma.task.deleteMany({ where: { createdById: u.id } }).catch(() => {});
    await prisma.notification.deleteMany({ where: { user: { email: { startsWith: TAG } } } }).catch(() => {});
    await prisma.user.deleteMany({ where: { email: { startsWith: TAG } } }).catch(() => {});
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
