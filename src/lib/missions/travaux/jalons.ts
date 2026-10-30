import { prisma } from "@/lib/prisma";
import { journaliser } from "@/lib/missions/runtime/store";
import type { JalonsAttente } from "@/lib/missions/travaux/plan";
import type { PersonaTravaux } from "@/lib/missions/travaux/persona";
import { expirerDemande, lienDemande } from "@/lib/missions/travaux/delegation";
import { signalerUneFois } from "@/lib/missions/travaux/signaux";
import { duree } from "@/lib/missions/travaux/regles";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES JALONS DES ATTENTES (J8, décision 0023) — relance, escalade, abandon : ce que le temps fait à une
 * attente qui dure, sans que personne ait à y penser.
 *
 *   ATTENTE (un fait métier, une signature, un paiement…) :
 *     relance  → la personne du travail est prévenue : « toujours rien, échéance le … » ;
 *     escalade → la personne du travail, ou son responsable hiérarchique (`a: RESPONSABLE`) ;
 *     l'échéance elle-même règle l'attente (issue TIMEOUT) — c'est le moteur (`reveillerAttentesTemporelles`).
 *   DEMANDE (« demander à ») :
 *     relance  → la personne sollicitée reçoit un rappel ;
 *     escalade → son responsable hiérarchique est prévenu, et la personne du travail le sait ;
 *     abandon  → la demande expire, l'étape se règle en TIMEOUT : le travail continue sans la réponse.
 *
 * Chaque jalon part UNE fois : une écriture conditionnelle (demandes) ou une clé au journal (attentes) — deux
 * exécutants pendant la bascule, ou un battement rejoué, n'envoient qu'un avis. Les dates sont ABSOLUES, posées
 * à l'approbation : un redémarrage ne décale rien.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface BilanJalons { relances: number; escalades: number; abandons: number }

const jour = (d: Date) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", timeZone: "Africa/Algiers" });
const nomDe = async (id: string) => (await prisma.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? "un collègue";

function lireJalons(v: unknown): JalonsAttente | null {
  const j = v && typeof v === "object" ? (v as { jalons?: unknown }).jalons : null;
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  const date = (x: unknown) => (typeof x === "string" && Number.isFinite(Date.parse(x)) ? x : null);
  return { relanceA: date(o.relanceA), escaladeA: date(o.escaladeA), escaladeVers: o.escaladeVers === "RESPONSABLE" ? "RESPONSABLE" : "PRINCIPAL" };
}

/** L'échéance d'une attente d'événement, quand elle en a une (branche `until` d'un `anyOf`). */
function echeanceDe(waitFor: unknown): string | null {
  const w = waitFor && typeof waitFor === "object" ? (waitFor as { until?: unknown; anyOf?: unknown[] }) : null;
  if (typeof w?.until === "string") return w.until;
  const b = (w?.anyOf ?? []).find((x) => x && typeof x === "object" && typeof (x as { until?: unknown }).until === "string") as { until: string } | undefined;
  return b?.until ?? null;
}

export async function traiterJalons(o: { persona?: PersonaTravaux; maintenant: Date; seulement?: readonly string[] }): Promise<BilanJalons> {
  const bilan: BilanJalons = { relances: 0, escalades: 0, abandons: 0 };
  const { maintenant } = o;
  const vivante = { kind: "TRAVAIL", status: { notIn: ["COMPLETED", "CANCELLED", "FAILED", "PAUSED"] as never[] }, ...(o.seulement ? { id: { in: [...o.seulement] } } : {}) };

  // ── LES ATTENTES D'ÉVÉNEMENT ─────────────────────────────────────────────────────────────
  const attentes = await prisma.missionStep.findMany({
    where: { status: "WAITING", nodeType: "WAIT_EVENT", supersededAt: null, mission: vivante },
    select: { missionId: true, key: true, title: true, input: true, waitFor: true, updatedAt: true, mission: { select: { title: true, principalId: true } } },
    take: 500,
  });
  for (const s of attentes) {
    const j = lireJalons(s.input);
    const principalId = s.mission.principalId;
    if (!j || !principalId) continue;
    const echeance = echeanceDe(s.waitFor);
    const fin = echeance ? ` — échéance le ${jour(new Date(echeance))}` : "";
    if (j.relanceA && new Date(j.relanceA) <= maintenant) {
      const envoye = await signalerUneFois(s.missionId, principalId, `relance:${s.key}`, `Toujours en attente : « ${s.title} »`,
        `Le travail « ${s.mission.title} » attend toujours, depuis ${duree(maintenant.getTime() - s.updatedAt.getTime())}${fin}.`);
      if (envoye) {
        bilan.relances += 1;
        await journaliser(s.missionId, "ATTENTE_RELANCE", `Relance : « ${s.title} » attend toujours${fin}.`, { stepKey: s.key }, principalId);
      }
    }
    if (j.escaladeA && new Date(j.escaladeA) <= maintenant) {
      const responsable = j.escaladeVers === "RESPONSABLE" && o.persona ? await o.persona.responsable(principalId) : null;
      const cible = responsable ?? principalId;
      const qui = await nomDe(principalId);
      const envoye = await signalerUneFois(s.missionId, cible, `escalade:${s.key}`, `Escalade : « ${s.title} »`,
        `${responsable ? `Le travail « ${s.mission.title} » de ${qui}` : `Votre travail « ${s.mission.title} »`} attend depuis ${duree(maintenant.getTime() - s.updatedAt.getTime())}${fin} : une décision est peut-être nécessaire.`,
        responsable ? "/assistant" : `/assistant?travail=${s.missionId}`);
      if (envoye) {
        bilan.escalades += 1;
        await journaliser(s.missionId, "ATTENTE_ESCALADE", `Escalade${responsable ? ` au responsable de ${qui}` : ""} : « ${s.title} »${fin}.`, { stepKey: s.key, vers: responsable ? "RESPONSABLE" : "PRINCIPAL" }, principalId);
      }
    }
  }

  // ── LES DEMANDES ─────────────────────────────────────────────────────────────────────────
  const demandes = await prisma.travailDemande.findMany({
    where: {
      statut: "OUVERTE", mission: vivante,
      OR: [{ relances: 0, relanceA: { lte: maintenant } }, { escaladeLe: null, escaladeA: { lte: maintenant } }, { abandonA: { lte: maintenant } }],
    },
    take: 200,
  });
  for (const d of demandes) {
    if (d.abandonA <= maintenant) {
      if (await expirerDemande(d.id, maintenant)) bilan.abandons += 1;
      continue;
    }
    const de = await nomDe(d.demandeurId);
    if (d.relances === 0 && d.relanceA && d.relanceA <= maintenant) {
      const pris = await prisma.travailDemande.updateMany({ where: { id: d.id, relances: 0 }, data: { relances: 1, derniereRelanceLe: maintenant } });
      if (pris.count === 1) {
        bilan.relances += 1;
        await signalerUneFois(d.missionId, d.destinataireId, `demande:${d.id}:relance`, `Rappel — ${de} attend votre réponse`,
          `${d.question.slice(0, 160)} — avant le ${jour(d.echeance)}.`, lienDemande(d.id));
        await journaliser(d.missionId, "ATTENTE_RELANCE", `Rappel envoyé à ${await nomDe(d.destinataireId)} (réponse attendue avant le ${jour(d.echeance)}).`, { demandeId: d.id, stepKey: d.stepKey }, d.demandeurId);
      }
    }
    if (d.escaladeLe === null && d.escaladeA && d.escaladeA <= maintenant) {
      const pris = await prisma.travailDemande.updateMany({ where: { id: d.id, escaladeLe: null }, data: { escaladeLe: maintenant } });
      if (pris.count !== 1) continue;
      bilan.escalades += 1;
      const sollicite = await nomDe(d.destinataireId);
      const responsable = o.persona ? await o.persona.responsable(d.destinataireId) : null;
      if (responsable && responsable !== d.demandeurId) {
        await signalerUneFois(d.missionId, responsable, `demande:${d.id}:escalade`, `Escalade — ${sollicite} n'a pas encore répondu à ${de}`,
          `« ${d.question.slice(0, 140)} » — réponse attendue depuis le ${jour(d.echeance)}.`, "/assistant");
      }
      await signalerUneFois(d.missionId, d.demandeurId, `demande:${d.id}:escalade-demandeur`, `Pas encore de réponse de ${sollicite}`,
        responsable ? "Son responsable hiérarchique vient d'être prévenu ; le travail continue d'attendre." : "Aucun responsable hiérarchique connu : le travail continue d'attendre.");
      await journaliser(d.missionId, "ATTENTE_ESCALADE", `Escalade : ${sollicite} n'a pas répondu à l'échéance${responsable ? " — son responsable est prévenu" : ""}.`, { demandeId: d.id, stepKey: d.stepKey, responsable: !!responsable }, d.demandeurId);
    }
  }
  return bilan;
}
