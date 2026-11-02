import type { PowerTool, UtilisateurOutil as CurrentUser } from "@/platform/ia/outil";
import {
  LIBELLE_TYPE_NOEUD, TYPES_NOEUD, dOuVient, estTypeNoeud, etatALaDate, explorerRelations, faitsDeLAttribut, lireRef, phraseRelation,
  resoudreEntite, texteProvenance, type NoeudDecrit, type Provenance, type Resolution, type TypeNoeud,
} from "@/modules/graphe-entreprise/api";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE GRAPHE DE L'ENTREPRISE ET LES FAITS DATÉS, POUR UN MODÈLE (lot J9, décision 0021).
 *
 *   • `explorer_relations(entité, profondeur ≤ 3, filtres)` — « qu'est-ce qui dépend de ce fournisseur ? », « qui a
 *     travaillé sur ce dossier ? », « quels documents parlent de ce produit ? » : des chemins, chacun avec sa source ;
 *   • `etat_a_une_date(entité, date)` — ce qui était vrai ce jour-là (faits confirmés et relations), et au besoin ce
 *     qu'on en SAVAIT à une autre date ;
 *   • `d_ou_vient(fait)` — la pièce, l'extraction, qui a confirmé et quand, ce qui a été remplacé.
 *
 * LES DROITS AVANT LE PARCOURS : le périmètre de la personne (modules et portées de l'écran, règle d'ouverture des
 * pièces) juge chaque nœud avant qu'il ne soit traversé ; une famille de la console FERMÉE retire ses types du graphe
 * (Réglementaire → dossiers, Ad & Pro → demandes et congrès, Drive & documents → documents) au lieu de refuser l'outil.
 * `pourModele` : ni pièce confidentielle, ni pièce du coffre, ni fait sensible. CHAQUE VALEUR CHIFFRÉE PORTE SA SOURCE
 * (`source`), et la sortie passe ensuite, comme toute sortie, le filtre du tour (repères ⟦Sn⟧).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

/** Ce qu'une famille FERMÉE de la console retire du graphe. */
const TYPES_DES_FAMILLES: Record<string, TypeNoeud[]> = { REGLEMENTAIRE: ["DOSSIER"], AD_PRO: ["DEMANDE_AD_PRO", "CONGRES"], DRIVE: ["DOCUMENT"] };
export const typesExclusPar = (famillesFermees: readonly string[]): TypeNoeud[] => [...new Set(famillesFermees.flatMap((f) => TYPES_DES_FAMILLES[f] ?? []))];

const txt = (v: unknown, max = 200) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const dateDe = (v: unknown): Date | null => {
  const s = txt(v, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
};
const src = (p: Provenance) => texteProvenance(p);
const noeud = (n: NoeudDecrit) => ({ ref: n.ref, type: LIBELLE_TYPE_NOEUD[n.type], nom: n.libelle, lien: n.lien, source: src(n.source) });

type Cible = { ok: true; ref: string; verdict: string } | { ok: false; sortie: string };

/** L'entité désignée : une référence rendue plus tôt (`TYPE:id`), sinon une mention résolue sous les droits. */
async function cible(u: CurrentUser, entree: unknown, exclus: TypeNoeud[], types?: TypeNoeud[]): Promise<Cible> {
  const m = txt(entree);
  if (m.length < 2) return { ok: false, sortie: JSON.stringify({ statut: "REFUS", raison: "Nomme l'entité (personne, organisation, produit, dossier, demande, congrès, document)." }) };
  if (lireRef(m)) return { ok: true, ref: m, verdict: "REFERENCE" };
  const r: Resolution = await resoudreEntite(u, m, { exclus, types, pourModele: true });
  if ((r.verdict === "CERTAIN" || r.verdict === "PROBABLE") && r.retenu) return { ok: true, ref: r.retenu.candidat.ref, verdict: r.verdict };
  if (r.verdict === "AMBIGU") {
    return { ok: false, sortie: JSON.stringify({
      statut: "AMBIGU",
      question: `« ${m} » peut désigner plusieurs entités : laquelle ? (rappelle l'outil avec sa référence)`,
      candidats: r.candidats.map((c) => ({ ref: c.candidat.ref, type: LIBELLE_TYPE_NOEUD[c.candidat.type as TypeNoeud] ?? c.candidat.type, nom: c.candidat.libelle, source: `index du référentiel · ${c.preuve}` })),
    }) };
  }
  return { ok: false, sortie: JSON.stringify({ statut: "INCONNU", note: `Aucune entité reconnue pour « ${m} » parmi celles que la personne peut voir.` }) };
}

const typesDe = (v: unknown): TypeNoeud[] => (Array.isArray(v) ? v.map((x) => String(x).toUpperCase()).filter(estTypeNoeud) : []);

function explorer(user: CurrentUser, exclus: TypeNoeud[]): PowerTool {
  return {
    def: {
      name: "explorer_relations",
      description:
        "LE GRAPHE DE L'ENTREPRISE : part d'une entité (personne, organisation/fournisseur, produit, dossier réglementaire, demande Ad & Pro, congrès, "
        + "document) et suit ses relations jusqu'à 3 sauts — « qu'est-ce qui dépend de ce fournisseur ? », « qui a travaillé sur ce dossier ? », "
        + "« quels documents parlent de ce produit ? ». Accepte un nom (arabe ou latin, sigle, NIF/RC) ou une référence TYPE:id rendue plus tôt. "
        + "Chaque résultat porte son chemin et sa SOURCE : cite-la pour chaque chiffre ou date que tu reprends.",
      input_schema: {
        type: "object",
        properties: {
          entite: { type: "string", description: "Nom, sigle, NIF/RC, ou référence TYPE:id." },
          profondeur: { type: "integer", minimum: 1, maximum: 3, description: "Sauts au plus (défaut 2)." },
          types: { type: "array", items: { type: "string", enum: [...TYPES_NOEUD] }, description: "Ne rendre que ces types (ex. [\"DOCUMENT\"])." },
          relations: { type: "array", items: { type: "string" }, description: "Ne suivre que ces relations (fourni_par, responsable_de, mentionne, concerne, atteste, demande, affilie_a…)." },
          date: { type: "string", description: "AAAA-MM-JJ : le graphe tel qu'il était ce jour-là." },
        },
        required: ["entite"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Relations explorées",
    run: async (entree, u) => {
      const c = await cible(u, entree.entite, exclus);
      if (!c.ok) return c.sortie;
      const profondeur = Math.max(1, Math.min(3, Number(entree.profondeur) || 2));
      const r = await explorerRelations(u, c.ref, {
        profondeur, typesVises: typesDe(entree.types), relations: Array.isArray(entree.relations) ? entree.relations.map(String) : undefined,
        aLaDate: dateDe(entree.date), exclus, pourModele: true, limite: 40,
      });
      if (!r.ok) return JSON.stringify({ statut: "INCONNU", note: "Entité introuvable parmi celles que la personne peut voir." });
      return JSON.stringify({
        meta: { profondeur, resolution: c.verdict, resultats: r.noeuds.length, tronque: r.tronque, date: txt(entree.date, 10) || null },
        entite: noeud(r.depart),
        resultats: r.noeuds.map((n) => ({
          ...noeud(n),
          distance: n.distance,
          chemin: n.chemin.map((e) => ({
            relation: phraseRelation(e.relation), de: e.de, a: e.a, depuis: e.depuis, jusqua: e.jusqua, note: e.note, source: src(e.source),
          })),
        })),
        ...(r.noeuds.length ? {} : { note: "Aucune relation visible pour la personne à cette profondeur." }),
      });
    },
  };
}

function etat(user: CurrentUser, exclus: TypeNoeud[]): PowerTool {
  return {
    def: {
      name: "etat_a_une_date",
      description:
        "L'ÉTAT D'UNE ENTITÉ, AUJOURD'HUI OU À UNE DATE : ses faits confirmés (raison sociale, forme juridique, capital, adresse, identité…) et ses "
        + "relations (responsable, fournisseur, affiliation…) tels qu'ils étaient ce jour-là — jamais la valeur d'aujourd'hui à la place. Sans date : "
        + "aujourd'hui (« quel est le capital de Saidal ? »). `connu_le` : ce que "
        + "le référentiel en savait à une autre date. Chaque valeur porte sa SOURCE ; un attribut sans valeur à cette date est listé « inconnu ».",
      input_schema: {
        type: "object",
        properties: {
          entite: { type: "string", description: "Nom, sigle, NIF/RC, ou référence TYPE:id." },
          date: { type: "string", description: "AAAA-MM-JJ (défaut : aujourd'hui)." },
          connu_le: { type: "string", description: "AAAA-MM-JJ (facultatif) : l'état tel qu'on le savait ce jour-là." },
        },
        required: ["entite"],
      },
    },
    allowed: (u) => u.id === user.id,
    label: "État à une date consulté",
    run: async (entree, u) => {
      const date = entree.date === undefined || entree.date === null || entree.date === "" ? new Date() : dateDe(entree.date);
      if (!date) return JSON.stringify({ statut: "REFUS", raison: "Date attendue au format AAAA-MM-JJ." });
      const c = await cible(u, entree.entite, exclus);
      if (!c.ok) return c.sortie;
      const r = await etatALaDate(u, c.ref, date, { connuLe: dateDe(entree.connu_le), exclus, pourModele: true });
      if (!r.ok) return JSON.stringify({ statut: "INCONNU", note: "Entité introuvable parmi celles que la personne peut voir." });
      return JSON.stringify({
        meta: { date: r.date, connuLe: r.connuLe, resolution: c.verdict },
        entite: noeud(r.entite),
        faits: r.valeurs.map((v) => ({ attribut: v.attribut, valeur: v.valeur, depuis: v.depuis, fait: v.fait, source: src(v.source) })),
        inconnus: r.inconnus,
        relations: r.relations.map((x) => ({
          relation: phraseRelation(x.relation), sens: x.sens, avec: noeud(x.avec), depuis: x.depuis, jusqua: x.jusqua, note: x.note, source: src(x.source),
        })),
        ...(r.valeurs.length || r.relations.length ? {} : { note: "Rien de connu à cette date pour cette entité (ou rien de lisible par la personne)." }),
      });
    },
  };
}

function provenance(user: CurrentUser, exclus: TypeNoeud[]): PowerTool {
  return {
    def: {
      name: "d_ou_vient",
      description:
        "D'OÙ VIENT UN FAIT : la pièce dont il a été lu, l'extraction (moteur, confiance, page, extrait), qui l'a confirmé et quand, ce qu'il a "
        + "remplacé, s'il a été fermé et par quoi, les conflits. Donne l'identifiant `fait` rendu par etat_a_une_date, ou l'entité et l'attribut.",
      input_schema: {
        type: "object",
        properties: {
          fait: { type: "string", description: "Identifiant d'un fait confirmé." },
          entite: { type: "string", description: "À défaut : l'entité (nom ou TYPE:id)…" },
          attribut: { type: "string", description: "…et l'attribut (raisonSociale, nif, adresse…)." },
        },
      },
    },
    allowed: (u) => u.id === user.id,
    label: "Provenance consultée",
    run: async (entree, u) => {
      let ids = [txt(entree.fait, 60)].filter(Boolean);
      if (!ids.length) {
        if (!txt(entree.entite) || !txt(entree.attribut)) return JSON.stringify({ statut: "REFUS", raison: "Donne `fait`, ou bien `entite` et `attribut`." });
        const c = await cible(u, entree.entite, exclus, ["PERSONNE", "ORGANISATION", "PRODUIT"]);
        if (!c.ok) return c.sortie;
        ids = (await faitsDeLAttribut(u, c.ref, txt(entree.attribut, 60))).slice(-3).map((f) => f.id);
        if (!ids.length) return JSON.stringify({ statut: "INCONNU", note: "Aucun fait lisible pour cet attribut." });
      }
      const chaines = (await Promise.all(ids.map((id) => dOuVient(u, id, { exclus, pourModele: true })))).filter((x): x is NonNullable<typeof x> => !!x);
      if (!chaines.length) return JSON.stringify({ statut: "INCONNU", note: "Fait introuvable, sensible, ou tiré d'une pièce que la personne ne peut pas ouvrir." });
      return JSON.stringify({
        provenances: chaines.map((p) => ({
          fait: { ...p.fait, source: src(p.fait.source) },
          sujet: p.sujet ? noeud(p.sujet) : null,
          origine: p.origine,
          piece: p.piece ? { ...p.piece, source: src(p.piece.source) } : null,
          extraction: p.extraction ? { ...p.extraction, source: src(p.extraction.source) } : null,
          confirmation: { ...p.confirmation, source: src(p.confirmation.source) },
          fermeture: p.fermeture ? { ...p.fermeture, source: src(p.fermeture.source) } : null,
          remplace: p.remplace.map((x) => ({ ...x, source: src(x.source) })),
          conflits: p.conflits.map((x) => ({ ...x, source: src(x.source) })),
        })),
      });
    },
  };
}

/** Les outils du graphe, pour CETTE personne ; `famillesFermees` : les familles de la console fermées pour elle. */
export function outilsGraphe(user: CurrentUser, famillesFermees: readonly string[] = []): PowerTool[] {
  const exclus = typesExclusPar(famillesFermees);
  return [explorer(user, exclus), etat(user, exclus), provenance(user, exclus)];
}

