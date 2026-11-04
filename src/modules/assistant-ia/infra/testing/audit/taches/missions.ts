/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE BANC D'AUDIT (décision 0050) — DOMAINE « missions » (lot P1 ter, décision 0066) : LIRE ses missions avec leur contenu.
 * Identifiants : MS-. Agrégé par `./index.ts`.
 *
 * Direction, 03/11 : « Donne les 3 missions qu'on a » → un tableau titre / état / 0/2 ; « y'a quoi dedans, elles ne
 * sont pas cliquables » ; « prête : part au prochain battement (moins d'une minute) » sans exécutant. Chaque tâche vérifie
 * EN BASE et dans la réponse : le CONTENU (titres d'étapes semées), une CARTE `mission` par mission avec « Ouvrir » vers
 * `/missions/<id>`, et aucune promesse « moins d'une minute » sans passage du balayage dans les 3 dernières minutes.
 *
 * LE SEMIS (`SEMIS_MISSIONS`) : trois missions du Super Admin de la persona, par le VRAI moteur (`proposerTravail`,
 * démarrées d'office), aux étapes nommées — c'est elles que la réponse doit savoir dire.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prisma } from "@/lib/prisma";
import { demarrerDOffice, PERSONA_ASSISTANT_IA, proposerTravail } from "../../../travaux";
import { tache, type ContexteVerification, type SemisDeDomaine, type Tache } from "./types";

/** Les missions semées : titre → titres de leurs étapes (ce que « y'a quoi dedans » doit rendre). */
export const MISSIONS_SEMEES: Record<string, string[]> = {
  "Suivi des appels d'offres CHU 2027": ["Lire les appels d'offres ouverts", "Comparer les prix proposés", "Rédiger le classeur de suivi"],
  "Planning des tournées Est — novembre": ["Lire les visites prévues", "Répartir les tournées par wilaya", "Rédiger le planning"],
  "Revue des stocks Nivolumab": ["Lire les stocks par dépôt", "Repérer les ruptures à venir", "Rédiger la note de synthèse"],
};

const MOINS_D_UNE_MINUTE = /moins d['’]une minute|prochain battement/i;

/** Un passage EFFECTIF du balayage des travaux dans les 3 dernières minutes (ce qui seul permet « moins d'une minute »). */
async function balayageRecent(): Promise<boolean> {
  const b = await prisma.tacheDeFond.findUnique({ where: { cle: "travaux.balayage" }, select: { dernierDebutA: true, dernierStatut: true } });
  return !!b?.dernierDebutA && b.dernierStatut !== "IGNOREE" && Date.now() - b.dernierDebutA.getTime() <= 3 * 60_000;
}

/** Les cartes `mission` de la réponse (blocs posés par le serveur), lues dans le texte des réponses. */
function cartesMission(c: ContexteVerification): { title: string; actions?: { libelle: string; href?: string }[]; etapes?: { label: string }[] }[] {
  const out: { title: string; actions?: { libelle: string; href?: string }[]; etapes?: { label: string }[] }[] = [];
  // Chaque réponse : le texte, puis les blocs du tour en JSON sur la DERNIÈRE ligne (`jouer.ts`).
  for (const r of c.reponses) {
    const derniere = r.slice(r.lastIndexOf("\n") + 1).trim();
    if (!derniere.startsWith("[")) continue;
    try {
      for (const b of JSON.parse(derniere) as { kind?: string }[]) if (b?.kind === "mission") out.push(b as (typeof out)[number]);
    } catch { /* des blocs illisibles ne sont pas des cartes */ }
  }
  return out;
}

/** Le vérificateur commun : contenu nommé, cartes cliquables, aucune promesse d'exécutant sans battement récent. */
const verifierLecture = (o: { contenuDe?: string[]; cartesMin?: number }) => async (c: ContexteVerification): Promise<string[]> => {
  const motifs: string[] = [];
  const tout = c.reponses.join("\n");
  for (const titre of o.contenuDe ?? []) {
    const etapes = MISSIONS_SEMEES[titre] ?? [];
    if (!etapes.some((e) => tout.includes(e))) motifs.push(`contenu absent : aucune étape de « ${titre} » n'est dite`);
  }
  const cartes = cartesMission(c);
  if (cartes.length < (o.cartesMin ?? 0)) motifs.push(`${cartes.length} carte(s) « mission » au lieu d'au moins ${o.cartesMin}`);
  const ids = await prisma.mission.findMany({ where: { principalId: c.userId, title: { in: Object.keys(MISSIONS_SEMEES) } }, select: { id: true, title: true } });
  for (const carte of cartes) {
    const id = ids.find((m) => m.title === carte.title)?.id;
    if (id && !carte.actions?.some((a) => a.href === `/missions/${id}`)) motifs.push(`la carte « ${carte.title} » n'ouvre pas /missions/${id}`);
  }
  if (MOINS_D_UNE_MINUTE.test(tout) && !(await balayageRecent())) motifs.push("« moins d'une minute / prochain battement » affirmé sans passage du balayage dans les 3 dernières minutes");
  return motifs;
};

const t = (id: string, tours: string | string[], o: { contenuDe?: string[]; cartesMin?: number; contient?: RegExp[]; interdit?: RegExp[]; voix?: boolean } = {}): Tache =>
  tache(id, "pilotage", "superadmin", tours, {
    ...(o.contient ? { contient: o.contient } : {}), ...(o.interdit ? { interdit: o.interdit } : {}),
  }, { verifier: verifierLecture(o), ...(o.voix ? { voix: true } : {}) });

export const TACHES_MISSIONS: Tache[] = [
  // ── Le scénario de la Direction (03/11) ──
  t("MS-01-les-3-missions", "Donne les 3 missions qu'on a.", { cartesMin: 3 }),
  t("MS-02-quoi-dedans", ["Donne les 3 missions qu'on a.", "Génial, mais y'a quoi dedans ?"], { contenuDe: Object.keys(MISSIONS_SEMEES), cartesMin: 3, interdit: [/ne fournit pas le contenu|je ne vais pas l['’]inventer|ne sais pas ce qu['’]elles contiennent/i] }),
  t("MS-03-une-mission", "Qu'est-ce que contient la mission sur les stocks de Nivolumab ? Où en est-elle ?", { contenuDe: ["Revue des stocks Nivolumab"], cartesMin: 1 }),
  t("MS-04-qui-bloque", "Pourquoi mes missions n'avancent pas ?", { cartesMin: 1, contient: [/worker|balayage|battement|exécutant|approbation|bloqu/i] }),
  t("MS-05-livrables", "Qu'est-ce que mes missions ont déjà produit comme livrables ?", { cartesMin: 1, contient: [/livrable|aucun|rien|pas encore/i] }),
  t("MS-06-voix", "Lis-moi mes missions en cours.", { voix: true, contient: [/appels d['’]offres|tournées Est|stocks Nivolumab/i] }),
];

/** Le semis : trois missions du Super Admin, par le vrai moteur, démarrées d'office (aucun geste dans leur plan). */
export const SEMIS_MISSIONS: SemisDeDomaine = async ({ users }) => {
  for (const [titre, etapes] of Object.entries(MISSIONS_SEMEES)) {
    const plan = {
      titre, objectif: `${titre} : un livrable relu, prêt à partager.`,
      etapes: etapes.map((e, i) => ({ cle: `e${i}`, type: i === etapes.length - 1 ? "LIVRABLE" : "ANALYSE", titre: e, consigne: e, ...(i === etapes.length - 1 ? { format: "md" } : {}), ...(i ? { apres: [`e${i - 1}`] } : {}) })),
    };
    const r = await proposerTravail(users.superadmin, PERSONA_ASSISTANT_IA, plan, { origine: "banc-audit-missions" });
    if (!r.ok) throw new Error(`banc d'audit (missions) : « ${titre} » refusé — ${r.fautes.join(" ")}`);
    const d = await demarrerDOffice(r.travailId, users.superadmin, PERSONA_ASSISTANT_IA);
    if (!d.ok) throw new Error(`banc d'audit (missions) : « ${titre} » non démarrée — ${d.erreur}`);
  }
  return {};
};
