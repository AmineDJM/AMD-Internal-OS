import { prisma } from "@/lib/prisma";
import { userCan } from "@/lib/rbac";
import { dossiersConnus } from "@/modules/suivi-dossiers/api";
import type { CurrentUser } from "@/lib/session";
import { lireTableur } from "@/platform/ia/analyse/tableur";
import { mettreAJourDossiersEnLot } from "@/lib/actions/dossier-actions";
import {
  phraseChangement, planDeMiseAJour, reperesColonnes, type ChangementApplique, type LigneTableau, type PlanMiseAJour,
} from "@/modules/suivi-dossiers/partage";
import { champs, texte, type OperationIA, type PropositionOperation } from "../../domaine/operations/types";
import { fichiersDepuisDrive, resoudrePiece } from "./pieces";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « VOICI L'EXCEL, METS À JOUR LE STATUT DES DOSSIERS » (lot T3) — un tableau → un LOT de changements, aperçu, confirmé
 * en un geste, annulable en un geste.
 *
 *   1. le fichier (désigné, ou à défaut le dernier tableur déposé par la personne dans les deux heures — dit sur la
 *      carte) est lu SUR CE SERVEUR (`lireTableur`) ; les colonnes se reconnaissent par leur en-tête ;
 *   2. les lignes se rapprochent des dossiers QUE LA PERSONNE VOIT (`scopeDossiers`) : référence, intitulé exact,
 *      intitulé approché contrôlé (`lib/dossiers/maj-lot.ts`) — une ligne ambiguë ou introuvable est LISTÉE, jamais
 *      devinée ; un dossier qu'elle voit sans pouvoir le modifier est listé « lecture seule » ; un dossier qu'elle ne
 *      voit pas est « introuvable » (la carte ne confirme jamais l'existence d'un sujet hors de sa portée) ;
 *   3. la CARTE est la simulation : chaque changement avant → après, et ce qui ne se fera pas, et pourquoi ;
 *   4. la confirmation appelle l'action de l'écran `mettreAJourDossiersEnLot` (gardes revérifiées ligne à ligne,
 *      tout ou rien, ligne modifiée depuis l'aperçu écartée) sous le journal des effets : UN geste, UNE annulation.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const EXT_TABLEUR = /\.(xlsx|xlsm|csv|tsv)$/i;
const RECENT_MS = 2 * 3_600_000;
const LISTE_MAX = 12;

/** Le dernier tableur que la personne a déposé (conversation ou Drive) — l'hypothèse quand rien n'est désigné. */
async function dernierTableur(user: CurrentUser): Promise<{ id: string; nom: string } | null> {
  const n = await prisma.driveNode.findMany({
    where: { ownerId: user.id, type: "FILE", isTrashed: false, createdAt: { gte: new Date(Date.now() - RECENT_MS) } },
    orderBy: { createdAt: "desc" }, take: 30, select: { id: true, name: true },
  });
  const t = n.find((x) => EXT_TABLEUR.test(x.name));
  return t ? { id: t.id, nom: t.name } : null;
}

const versLigne = (l: Record<string, unknown>, numero: number, noms: string[], c: ReturnType<typeof reperesColonnes>): LigneTableau => {
  const v = (i: number | undefined) => (i === undefined ? null : l[noms[i]!] ?? null);
  const s = (i: number | undefined) => { const x = v(i); return x === null || x === undefined ? null : String(x).trim() || null; };
  return { numero, reference: s(c.reference), titre: s(c.titre), statut: s(c.statut), echeance: v(c.echeance), priorite: s(c.priorite) };
};

const borne = (xs: string[]): string => (xs.length > LISTE_MAX ? `${xs.slice(0, LISTE_MAX).join(" ; ")} ; … et ${xs.length - LISTE_MAX} autre(s)` : xs.join(" ; "));

/** Le rapport d'un plan, en champs de carte (et en sortie pour le modèle). */
export function rapportDuPlan(plan: PlanMiseAJour): [string, string | null][] {
  return [
    ["Changements", plan.changements.length ? borne(plan.changements.map(phraseChangement)) : "aucun"],
    ["Déjà à jour", plan.inchanges.length ? `${plan.inchanges.length} dossier(s)` : null],
    ["Lignes ambiguës (non appliquées)", plan.ambigus.length ? borne(plan.ambigus.map((a) => `ligne ${a.numero} « ${a.texte} » : ${a.candidats.join(" ou ")}`)) : null],
    ["Lignes introuvables (non appliquées)", plan.introuvables.length ? borne(plan.introuvables.map((a) => `ligne ${a.numero} « ${a.texte} »`)) : null],
    ["Lecture seule (non appliquées)", plan.lectureSeule.length ? borne(plan.lectureSeule.map((a) => `ligne ${a.numero} ${a.reference} : réservé au créateur, au responsable ou à la Direction`)) : null],
    ["Erreurs de saisie (non appliquées)", plan.erreurs.length ? borne(plan.erreurs.map((a) => `ligne ${a.numero} ${a.texte} : ${a.raison}`)) : null],
    ["Doublons (non appliqués)", plan.doublons.length ? borne(plan.doublons.map((a) => `ligne ${a.numero} ${a.reference} (déjà plus haut)`)) : null],
  ];
}

export const DOSSIERS_EXCEL: OperationIA = {
  nom: "maj_dossiers_depuis_tableau",
  module: "DOSSIERS",
  libelle: "Mise à jour des dossiers depuis un tableau préparée",
  description:
    "MET À JOUR EN LOT le Suivi de dossiers (DOS-AAAA-NNN) depuis un EXCEL ou un CSV : statut, échéance, priorité. "
    + "À utiliser pour « voici l'Excel, mets à jour le statut des dossiers », « applique ce tableau au suivi ». "
    + "Donne `fichier` (nom ou identifiant ; sans lui, le dernier tableur déposé est pris). Le serveur lit le fichier, reconnaît les colonnes, "
    + "rapproche chaque ligne d'un dossier (référence, intitulé exact ou approché contrôlé) et rend une CARTE : les changements avant → après, "
    + "et les lignes ambiguës, introuvables, en lecture seule ou en erreur. Ne lis PAS le fichier toi-même et n'invente aucune correspondance.",
  schema: {
    type: "object",
    properties: {
      fichier: { type: "string", description: "Le tableur : nom ou identifiant du fichier (Drive ou glissé dans la conversation)." },
      feuille: { type: "string", description: "Le nom de la feuille, s'il y en a plusieurs et que la personne l'a dit." },
    },
  },
  ouverte: (u) => userCan(u, "DOSSIERS", "VIEW"),

  async proposer(e, user): Promise<PropositionOperation> {
    const designe = texte(e, "fichier");
    const piece = designe ? await resoudrePiece(user, designe) : await dernierTableur(user);
    if (!piece) return { manque: ["le tableur des dossiers : glissez l'Excel (ou le CSV) dans la conversation"] };
    if ("erreur" in piece) return { erreur: piece.erreur };
    if (!EXT_TABLEUR.test(piece.nom)) return { erreur: `« ${piece.nom} » n'est pas un tableur (attendu : .xlsx, .csv).` };
    const f = await fichiersDepuisDrive(user, [piece.id]);
    if (!Array.isArray(f) || !f[0]) return { erreur: Array.isArray(f) ? "Le tableur est introuvable." : f.erreur };
    const lu = await lireTableur(Buffer.from(await f[0].arrayBuffer()), piece.nom, { max: 2_000 });
    if (!lu.ok) return { erreur: `Le tableur ne se lit pas : ${lu.erreur}.` };
    const voulue = texte(e, "feuille").toLowerCase();
    const candidates = lu.feuilles.filter((s) => !voulue || s.nom.toLowerCase().includes(voulue));
    const feuille = candidates.map((s) => ({ s, c: reperesColonnes(s.colonnes.map((c) => c.nom)) }))
      .find(({ c }) => (c.reference !== undefined || c.titre !== undefined) && (c.statut !== undefined || c.echeance !== undefined || c.priorite !== undefined));
    if (!feuille) {
      return { erreur: `Aucune feuille de « ${piece.nom} » n'a à la fois une colonne pour désigner le dossier (Référence ou Intitulé) et une colonne à appliquer (Statut, Échéance ou Priorité). Colonnes lues : ${lu.feuilles.map((s) => `${s.nom} — ${s.colonnes.map((c) => c.nom).join(", ")}`).join(" | ")}.` };
    }
    const noms = feuille.s.colonnes.map((c) => c.nom);
    const lignes = feuille.s.lignes.map((l, i) => versLigne(l, feuille.s.ligneEntete + i + 1, noms, feuille.c));
    const plan = planDeMiseAJour(lignes, await dossiersConnus(user));
    const rapport = rapportDuPlan(plan);
    if (!plan.changements.length) {
      return { erreur: `Rien à appliquer depuis « ${piece.nom} » (${lignes.length} ligne(s) lue(s)). ${rapport.filter(([, v]) => v).map(([k, v]) => `${k} : ${v}`).join(". ")}.` };
    }
    const warnings: string[] = [];
    if (!designe) warnings.push(`Fichier pris par défaut : « ${piece.nom} », le dernier tableur que vous avez déposé.`);
    const approches = plan.changements.filter((c) => c.approche).length;
    if (approches) warnings.push(`${approches} ligne(s) rapprochée(s) par un intitulé APPROCHÉ (sans référence) : vérifiez-les.`);
    const ecartees = plan.ambigus.length + plan.introuvables.length + plan.lectureSeule.length + plan.erreurs.length + plan.doublons.length;
    if (ecartees) warnings.push(`${ecartees} ligne(s) ne seront PAS appliquées (détail ci-dessus).`);
    const lot: ChangementApplique[] = plan.changements.map((c) => ({ id: c.id, avant: c.avant, ...c.apres }));
    return {
      carte: {
        title: `Mise à jour de ${plan.changements.length} dossier${plan.changements.length > 1 ? "s" : ""} depuis « ${piece.nom} »`,
        fields: champs([["Fichier", `${piece.nom} — feuille « ${feuille.s.nom} », ${lignes.length} ligne(s)`], ...rapport]),
        warnings,
        libelleBouton: `Appliquer ${plan.changements.length} changement${plan.changements.length > 1 ? "s" : ""}`,
      },
      args: { changements: JSON.stringify(lot), fichier: piece.nom, total: String(plan.changements.length) },
    };
  },

  async executer(a) {
    const fd = new FormData();
    fd.set("changements", a.changements ?? "[]");
    const r = await mettreAJourDossiersEnLot(fd);
    if (!r.ok) return { ok: false, error: r.error ?? "La mise à jour n'a pas pu être appliquée." };
    return { ok: true, message: `${r.message ?? "Dossiers mis à jour."} (source : ${a.fichier ?? "tableau"}) — annulable en un geste depuis « Ce que l'assistant a fait ».`, link: "/dossiers", revalidate: ["/dossiers"] };
  },
};
