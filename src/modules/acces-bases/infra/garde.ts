/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * L'ÉVALUATEUR DE LA GARDE (lot D3, décision 0057) — le juge que le socle appelle pour chaque requête.
 *
 * Il doit être SYNCHRONE et quasi gratuit : il est appelé des milliers de fois par page. D'où un INSTANTANÉ des
 * réglages en mémoire, rafraîchi en arrière-plan (toutes les 30 s, et jamais sur le chemin de la requête). Un
 * instantané vide ne juge rien : au démarrage, l'ERP se comporte exactement comme avant.
 *
 * D3 : il COMPTE ce qui aurait été refusé (`ObservationAccesBase`), il ne refuse pas. Le refus réel est le lot D4.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
import { prismaBrut } from "@/lib/prisma";
import { sansBloquer } from "@/lib/journal";
import { enSysteme, estSysteme, poserEvaluateurDonnees, type EvaluateurDonnees } from "@/platform/donnees/contexte";
import {
  COLONNES_REFERENCE, appliqueeSur, baseDe, baseDuModele, droitEffectif, droitParModules, empreinteRefus, estModeStrict,
  niveauPour, type ModeStrict,
} from "../domaine/regle";
import type { ReglageBase } from "../domaine/types";
import { compterObservation } from "./observations";
import { propresDonnees, reglagesVivants } from "./reglages";

const FRAICHEUR_MS = 30_000;

/** Ce que l'évaluateur sait, en mémoire : les réglages, le mode strict, ses propres données par base, la fiche RH de chacun. */
interface Instantane {
  reglages: readonly ReglageBase[];
  strict: ModeStrict;
  propres: Readonly<Record<string, boolean>>;
  fiches: ReadonlyMap<string, string>;
  expire: number;
}
const VIDE: Omit<Instantane, "expire"> = { reglages: [], strict: "AUCUNE", propres: {}, fiches: new Map() };
let instantane: Instantane = { ...VIDE, expire: 0 };
let enCours = false;

/** Relit tout, hors de toute personne (contexte système) : l'évaluateur ne se juge pas lui-même. */
async function relire(): Promise<Omit<Instantane, "expire">> {
  return enSysteme("instantané de l'accès par base", async () => {
    const [reglages, reglage, propres, fiches] = await Promise.all([
      reglagesVivants(),
      prismaBrut.appSetting.findUnique({ where: { id: "global" }, select: { accesBasesStrict: true } }),
      propresDonnees(),
      prismaBrut.employee.findMany({ where: { userId: { not: null } }, select: { id: true, userId: true } }),
    ]);
    const mode = reglage?.accesBasesStrict;
    return {
      reglages, propres,
      strict: estModeStrict(mode) ? mode : "AUCUNE",
      fiches: new Map(fiches.map((f) => [f.userId!, f.id])),
    };
  });
}

/** Rafraîchit l'instantané en arrière-plan : la requête qui a vu l'instantané périmé n'attend pas. */
function rafraichirSiBesoin(): void {
  if (enCours || Date.now() < instantane.expire) return;
  enCours = true;
  instantane = { ...instantane, expire: Date.now() + FRAICHEUR_MS };
  void relire()
    .then((i) => { instantane = { ...i, expire: Date.now() + FRAICHEUR_MS }; })
    .catch(sansBloquer("acces-bases: instantané des réglages"))
    .finally(() => { enCours = false; });
}

/** Relit l'instantané TOUT DE SUITE (après un réglage de la console : la garde n'attend pas 30 s). */
export async function rafraichirGardeMaintenant(): Promise<void> {
  instantane = { ...(await relire()), expire: Date.now() + FRAICHEUR_MS };
}

/** Pour les bancs : impose un instantané (ou le vide) sans attendre le rafraîchissement. */
export function poserInstantaneDeTest(reglages: readonly ReglageBase[] | null, autre: Partial<Omit<Instantane, "reglages" | "expire">> = {}): void {
  instantane = reglages ? { ...VIDE, ...autre, reglages, expire: Date.now() + FRAICHEUR_MS } : { ...VIDE, expire: 0 };
}

export const evaluateurAccesBases: EvaluateurDonnees = ({ modele, geste, contexte }) => {
  rafraichirSiBesoin();
  if (!contexte || estSysteme(contexte)) return null; // une tâche de fond déclarée n'est pas une personne
  if (!instantane.reglages.length) return null; // aucun réglage : rien à juger
  const cle = baseDuModele(modele);
  const base = cle ? baseDe(cle) : null;
  // Les bases TECHNIQUES ne se règlent pas : l'ERP ne tourne pas sans elles (comptes, journaux, plateforme).
  if (!base || base.nature === "technique") return null;

  const n = niveauPour({ userId: contexte.userId, roles: contexte.roles }, base.cle, instantane.reglages, new Date());
  if (n.niveau === "NORMAL") return null;
  const droit = droitEffectif(droitParModules(base, contexte.peut), n, base.nom);
  const permis = geste === "lecture" ? droit.lecture : droit.ecriture;
  if (permis) return null;

  compterObservation({ base: base.cle, userId: contexte.userId, geste, niveau: n.niveau, modele });
  const applique = appliqueeSur(instantane.strict, base);
  return {
    refus: `La base « ${base.nom} » vous est ${n.niveau === "FERMEE" ? "fermée" : "ouverte en lecture seule"} — demandez à la Direction.`,
    applique,
    digest: empreinteRefus(base.cle, n.niveau),
    reference: COLONNES_REFERENCE,
    // Ses propres données (paramètre de la base) : en lecture seulement — une base en lecture seule reste en lecture seule.
    propres: applique && geste === "lecture" && instantane.propres[base.cle]
      ? { userId: contexte.userId, employeId: instantane.fiches.get(contexte.userId) ?? null }
      : null,
  };
};

/** Branche la garde (appelé au démarrage du serveur, `src/instrumentation.ts`). */
export function brancherGardeDonnees(): void {
  poserEvaluateurDonnees(evaluateurAccesBases);
}

/** Débranche la garde (fin de banc). */
export function debrancherGardeDonnees(): void {
  poserEvaluateurDonnees(null);
}
