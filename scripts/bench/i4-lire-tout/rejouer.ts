/**
 * LOT I4 (décision 0067) — REJEU AU VRAI MODÈLE de la mission de production du 04/11/2026, de bout en bout :
 *   1. « Cartographie des chefs de service d'infectiologie en Algérie » demandée au Super Admin (chemin du produit, `jouerTour`) :
 *      le modèle propose le plan (`proposerTravail`, essai à blanc), le plan démarre d'office (`demarrerDOffice`), le WORKER
 *      RÉEL (`npm run worker`, `TACHES_DE_FOND=les-deux`) le conduit ; on relit le xlsx déposé : les bons praticiens, les
 *      liens, la vérification, les limites calculées ;
 *   2. la même demande en conversation (Super Admin) ;
 *   3. la même demande par un DÉLÉGUÉ : son secteur seulement.
 *
 * Base LOCALE de banc (`amd_bench`), annuaire FICTIF (`semerAnnuaireI4`), retiré à la fin. `ADAM_SORTIE_INTERDITE=1`, aucun
 * canal (Google, SMTP, WhatsApp, VAPID) : rien ne part. Budget `I4_BUDGET_USD` (défaut 3).
 *
 *   NODE_USE_ENV_PROXY=1 OPENAI_API_KEY=sk-proxy DATABASE_URL=postgresql://amd:amd@localhost:5432/amd_bench \
 *     npx tsx scripts/bench/i4-lire-tout/rejouer.ts
 */
process.env.ASSISTANT_IA_PRICE_IN ||= "2";
process.env.ASSISTANT_IA_PRICE_OUT ||= "12";
process.env.ADAM_SORTIE_INTERDITE = "1";
import fs from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import ExcelJS from "exceljs";
import { prisma } from "@/lib/prisma";
import type { CurrentUser } from "@/lib/session";
import { effacerAnnuaireI4, semerAnnuaireI4, sessionDe } from "@/modules/assistant-ia/api-banc";
import * as svc from "@/modules/assistant-ia/api";
import { portsArtefact } from "@/platform/ia/artifact/ports";
import { demarrerDOffice } from "@/lib/missions/travaux/service";

const BUDGET = Number(process.env.I4_BUDGET_USD ?? "3");
const TAG = `(fictif ${Date.now().toString(36).slice(-4)})`;
const SORTIE = process.env.OUT ?? "docs/assistant/preuves/i4/rejeu-vrai-modele.json";
const MISSION = "Lance une mission : Cartographie des chefs de service d'infectiologie en Algérie. Livrable : un tableau Excel avec nom, établissement, service, wilaya, téléphone et e-mail.";
const QUESTION = "Quels sont les chefs de service d'infectiologie en Algérie dans notre annuaire ? Donne nom, établissement et wilaya.";

async function compte(role: string, nom: string): Promise<CurrentUser> {
  const u = await prisma.user.create({ data: { email: `${nom}.${Date.now().toString(36)}@adventum-bench.dz`, name: `${nom} ${TAG}`, role: role as never, passwordHash: "x", isActive: true } });
  return sessionDe(u.id);
}
const conso = async (userId: string, depuis: Date) => {
  const l = await prisma.modelCallLog.aggregate({ where: { userId, at: { gte: depuis } }, _sum: { costUsd: true }, _count: true });
  return { coutUsd: Number(l._sum.costUsd ?? 0), appels: l._count };
};
const trouves = (texte: string, noms: string[]) => noms.filter((n) => texte.includes(n.replace(` ${TAG}`, "").replace(/^(Pr|Dr) /, "")));

/** Le worker RÉEL, sans aucun canal sortant ni jeton dans son environnement. */
function lancerWorker(): () => void {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(GOOGLE_|SMTP|WHATSAPP|VAPID|GITHUB_TOKEN|RENDER_)/.test(k)));
  const log = fs.openSync("/tmp/i4-worker.log", "w");
  const w: ChildProcess = spawn("npm", ["run", "worker"], { env: { ...env, TACHES_DE_FOND: "les-deux", ADAM_SORTIE_INTERDITE: "1" } as unknown as NodeJS.ProcessEnv, stdio: ["ignore", log, log], detached: true });
  return () => { try { process.kill(-w.pid!, "SIGTERM"); } catch { /* déjà parti */ } };
}

async function main() {
  const [sa, delegue] = [await compte("SUPER_ADMIN", "Amine"), await compte("MEDICAL_DELEGATE", "Yanis")];
  const semis = await semerAnnuaireI4(TAG, delegue.id);
  const out: Record<string, unknown> = { modele: process.env.ASSISTANT_IA_MODEL ?? "(défaut du produit)", attendus: semis.attendus, duDelegue: semis.duDelegue };
  const ecrire = () => { fs.mkdirSync(SORTIE.replace(/\/[^/]+$/, ""), { recursive: true }); fs.writeFileSync(SORTIE, JSON.stringify(out, null, 2)); };
  let total = 0;
  let arreterWorker: (() => void) | null = null;
  try {
    // ── 1. LA MISSION ── (`I4_SEULEMENT=conversation` : la sauter)
    if (process.env.I4_SEULEMENT !== "conversation") {
    const debut = new Date();
    const t = await svc.jouerTour(sa, { texte: MISSION, pieces: [], historique: [] });
    const travaux = t.ok ? ((t as { travaux?: string[] }).travaux ?? []) : [];
    const missions = await prisma.mission.findMany({ where: { principalId: sa.id, kind: "TRAVAIL" }, select: { id: true, title: true, status: true, carnet: true } });
    out.mission = { reponse: t.ok ? t.content : (t as { error?: string }).error, outils: t.ok ? t.outilsAppeles : [], travaux, plans: missions.map((m) => ({ titre: m.title, statut: m.status, etapes: (m.carnet as { plan?: { etapes?: unknown[] } })?.plan?.etapes })) };
    for (const m of missions.filter((x) => x.status === "AWAITING_APPROVAL")) out.demarrage = await demarrerDOffice(m.id, sa.id, svc.PERSONA_ASSISTANT_IA);
    ecrire();
    arreterWorker = lancerWorker();
    const fin = Date.now() + 12 * 60_000;
    let etat: { id: string; status: string }[] = [];
    while (Date.now() < fin) {
      etat = await prisma.mission.findMany({ where: { principalId: sa.id, kind: "TRAVAIL" }, select: { id: true, status: true } });
      if (etat.length && etat.every((m) => ["COMPLETED", "FAILED", "CANCELLED", "PARTIAL", "BLOCKED"].includes(m.status))) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    arreterWorker(); arreterWorker = null;
    const etapes = await prisma.missionStep.findMany({ where: { missionId: { in: etat.map((m) => m.id) } }, select: { key: true, title: true, status: true, capability: true, error: true, input: true }, orderBy: { createdAt: "asc" } });
    const livrables = await prisma.driveNode.findMany({ where: { ownerId: sa.id, type: "FILE", name: { endsWith: ".xlsx" }, isTrashed: false }, select: { id: true, name: true } });
    const classeurs = [];
    for (const l of livrables) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load((await portsArtefact.documents.lire(sa.id, l.id, (await prisma.fileVersion.findFirstOrThrow({ where: { nodeId: l.id }, orderBy: { version: "desc" }, select: { version: true } })).version)) as never);
      const feuilles = wb.worksheets.map((f) => ({ nom: f.name, lignes: f.getSheetValues().slice(1).map((v) => (Array.isArray(v) ? v.slice(1).map((x) => (x === undefined || x === null ? "" : String(x))) : [])) }));
      const texte = JSON.stringify(feuilles);
      classeurs.push({ nom: l.name, feuilles, trouves: trouves(texte, semis.attendus), intrus: ["Lina Haddad", "Yacine Rahmani", "Farid Kaci", "Omar Saadi"].filter((n) => texte.includes(n)) });
    }
    total += (await conso(sa.id, debut)).coutUsd;
    out.missionFin = { statuts: etat, etapes, classeurs, coutUsd: total };
    ecrire();
    console.log(`mission : ${etat.map((m) => m.status).join(", ")} · ${classeurs.map((c) => `${c.nom} : ${c.trouves.length}/${semis.attendus.length} bons, intrus ${c.intrus.length}`).join(" ; ")} · ${total.toFixed(3)} $`);
    }

    // ── 2 & 3. LA CONVERSATION — Super Admin, puis délégué ──
    for (const [qui, u, attendus] of [["superAdmin", sa, semis.attendus], ["delegue", delegue, semis.duDelegue]] as const) {
      if (total > BUDGET) { out[qui] = { saute: "budget atteint" }; continue; }
      const d = new Date();
      const r = await svc.jouerTour(u, { texte: QUESTION, pieces: [], historique: [] });
      const c = await conso(u.id, d);
      total += c.coutUsd;
      // La réponse ET les blocs affichés sous elle (un tableau lu n'est pas recopié dans le texte, il est montré).
      const texte = r.ok ? `${r.content}\n${JSON.stringify((r as { blocs?: unknown }).blocs ?? [])}` : String((r as { error?: string }).error);
      out[qui] = { reponse: texte.slice(0, 6000), outils: r.ok ? r.outilsAppeles : [], ...c, trouves: trouves(texte, attendus), horsSecteur: qui === "delegue" ? trouves(texte, semis.attendus.filter((n) => !semis.duDelegue.includes(n))) : undefined };
      console.log(`${qui} : ${trouves(texte, attendus).length}/${attendus.length} · ${c.coutUsd.toFixed(3)} $ · ${(r.ok ? r.outilsAppeles : []).join(", ")}`);
      ecrire();
    }
  } finally {
    arreterWorker?.();
    out.coutTotalUsd = total;
    ecrire();
    await effacerAnnuaireI4(TAG).catch(() => {});
    console.log(`coût total ${total.toFixed(3)} $ → ${SORTIE}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
