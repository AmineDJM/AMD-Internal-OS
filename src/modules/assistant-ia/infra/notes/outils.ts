import type { PowerTool } from "@/platform/ia/outil";
import type { CurrentUser } from "@/lib/session";
import {
  CoffretDuTour, jetonnerMontants, jetonnerTexte, MASQUE_CONFIDENTIEL, remplacerReperes,
} from "../../domaine/filtre-confidentialite";
import { resoudreAccesIa, type AccesIa } from "../../domaine/acces-regles";
import { droitsApplicatifsIa, substituerReperes } from "../role-config";
import { estTypeBloc, nettoyerTexte, nettoyerTitrePage, nouvelIdBloc, raccourci, type BlocNote, type TypeBloc } from "../../domaine/notes/blocs";
import { plierNote, resoudreLigne, resoudrePosition, resumeGeste, type GesteNote, type Resolution } from "../../domaine/notes/gestes";
import { borner, estLigneSensible, lignesPourModele } from "../../domaine/notes/regles";
import { listerPages, lirePage, nouvelIdPage } from "./pages";
import { pagesProposees, pageVirtuelle, proposer } from "./propositions";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « MES NOTES » — LES OUTILS DE L'ASSISTANT (décision 0026) — les mêmes à l'écrit et à la voix.
 *
 *   lire_notes       lit SES notes — seulement quand la question s'y rapporte (l'outil n'est pas du socle : il
 *                    n'est offert que si la demande parle de notes, de liste, de ce qui reste…) ;
 *   ajouter_note, modifier_note, cocher_note, deplacer_note, supprimer_note, creer_page, renommer_page
 *                    PROPOSENT une modification (décision de la Direction : toute modification par l'IA demande la
 *                    confirmation) — rien n'est écrit avant que la personne accepte dans son panneau ou sur la carte.
 *
 * Toujours les notes de la personne DU TOUR, jamais d'une autre (aucun paramètre ne désigne un compte) ; refusé en
 * « Vue exacte » : un Super Admin qui visualise l'OS comme quelqu'un ne lit pas ses notes. Un montant d'une ligne
 * sensible (paie, prime, IBAN…) part au modèle en repère ⟦Sn⟧ ; un repère écrit par le modèle est remis en clair
 * seulement si la personne a le droit de le voir.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export const OUTILS_NOTES_ECRITURE = [
  "ajouter_note", "modifier_note", "cocher_note", "deplacer_note", "supprimer_note", "creer_page", "renommer_page",
] as const;
export const OUTILS_NOTES = ["lire_notes", ...OUTILS_NOTES_ECRITURE] as const;

/** Au plus autant de propositions par tour — au-delà, l'assistant demande de relire avant de continuer. */
export const PROPOSITIONS_MAX_PAR_TOUR = 12;

export interface OptionsOutilsNotes {
  coffret?: CoffretDuTour | null;
  acces?: AccesIa;
  /** Les propositions du tour (la carte de la conversation les liste). */
  proposees?: string[];
  canal?: "texte" | "voix";
}

const REFUS_VUE_EXACTE = JSON.stringify({ statut: "REFUS", raison: "Les notes sont privées : elles ne s'ouvrent pas en « Vue exacte », même au Super Admin." });
const texteDe = (e: Record<string, unknown>, cle: string) => (typeof e[cle] === "string" ? (e[cle] as string).trim() : "");

type PageResolue = { ok: true; pageId: string; titre: string; dependDe: string[] } | { ok: false; sortie: string };

/** LA PAGE désignée (titre ou référence) parmi les siennes et celles proposées ; sans désignation : l'unique, ou la question. */
async function resoudrePage(userId: string, ref: string, indice?: (pageId: string) => Promise<boolean>): Promise<PageResolue> {
  const pages = await listerPages(userId);
  const proposees = await pagesProposees(userId);
  const toutes = [...pages.map((p) => ({ pageId: p.id, titre: p.titre, dep: [] as string[] })), ...proposees.map((p) => ({ pageId: p.pageId, titre: p.titre, dep: [p.propositionId] }))];
  const liste = toutes.map((p) => ({ page: p.titre, ref: p.pageId }));
  if (!ref) {
    if (toutes.length === 1) return { ok: true, pageId: toutes[0].pageId, titre: toutes[0].titre, dependDe: toutes[0].dep };
    if (indice) {
      const portent = [];
      for (const p of toutes) if (await indice(p.pageId)) portent.push(p);
      if (portent.length === 1) return { ok: true, pageId: portent[0].pageId, titre: portent[0].titre, dependDe: portent[0].dep };
    }
    return { ok: false, sortie: JSON.stringify({ statut: "INCOMPLET", raison: "La personne a plusieurs pages : laquelle ?", pages: liste, consigne: "Demande la page ; ne choisis pas." }) };
  }
  const q = plierNote(ref);
  const exacte = toutes.filter((p) => p.pageId === ref || plierNote(p.titre) === q);
  const trouvees = exacte.length ? exacte : toutes.filter((p) => plierNote(p.titre).includes(q));
  if (trouvees.length === 1) return { ok: true, pageId: trouvees[0].pageId, titre: trouvees[0].titre, dependDe: trouvees[0].dep };
  return {
    ok: false,
    sortie: JSON.stringify(trouvees.length
      ? { statut: "AMBIGU", raison: `Plusieurs pages portent « ${ref} ».`, pages: trouvees.map((p) => ({ page: p.titre, ref: p.pageId })), consigne: "Demande laquelle." }
      : { statut: "INTROUVABLE", raison: `Aucune page « ${ref} ».`, pages: liste, consigne: "Propose creer_page si la personne veut une nouvelle page." }),
  };
}

const sortieResolution = (r: Exclude<Resolution, { ok: true }>, quoi: string) => JSON.stringify({
  statut: r.statut,
  raison: r.statut === "AMBIGU" ? `Plusieurs ${quoi}s correspondent.` : `Aucun${quoi === "ligne" ? "e" : ""} ${quoi} ne correspond.`,
  candidats: r.candidats.map((c) => ({ ref: c.id, texte: c.texte })),
  consigne: r.statut === "AMBIGU" ? "Demande laquelle (cite les candidates) ; ne devine pas." : "Relis les notes (lire_notes) ou demande.",
});

export function outilsNotes(user: CurrentUser, o: OptionsOutilsNotes = {}): PowerTool[] {
  const aSoi = (u: CurrentUser) => u.id === user.id;
  const visualise = !!(user.impersonatedBy || user.visualise);
  const proposees = o.proposees ?? [];
  const canal = o.canal ?? "texte";
  const acces = o.acces ?? resoudreAccesIa({ superAdmin: user.role === "SUPER_ADMIN", droits: droitsApplicatifsIa(user) });

  /** Un texte de note, tel que le modèle le lit : repères posés (titulaire : la personne elle-même). */
  const pourModele = (coffret: CoffretDuTour, pageId: string) => (texte: string) => {
    const ctx = { titulaireUserId: user.id, source: { modele: "AssistantIaNotePage", id: pageId } };
    const t = jetonnerTexte(texte, coffret, ctx);
    return estLigneSensible(t) ? jetonnerMontants(t, coffret, ctx) : t;
  };

  /** LA PROPOSITION d'un geste : enregistrée, comptée pour la carte, et dite au modèle — sans valeur en clair. */
  const proposerEtDire = async (g: GesteNote, page: string, contexte: Parameters<typeof resumeGeste>[2], dependDe: string[], substitues: { n: number; e: { valeur: string } }[]) => {
    if (proposees.length >= PROPOSITIONS_MAX_PAR_TOUR) {
      return JSON.stringify({ statut: "REFUS", raison: `${PROPOSITIONS_MAX_PAR_TOUR} propositions dans ce tour : laisse la personne les relire avant d'en proposer d'autres.` });
    }
    const p = await proposer(user.id, g, resumeGeste(g, page, contexte), { dependDe: [...new Set(dependDe)], canal });
    proposees.push(p.id);
    let sortie = JSON.stringify({
      statut: "PROPOSEE",
      proposition: p.resume,
      consigne: "RIEN N'EST ÉCRIT : la modification est proposée dans « Mes notes » (surlignée) et sur une carte ; la personne l'accepte ou la refuse. "
        + "Dis « je vous propose… », jamais « c'est fait » ni « j'ai ajouté ».",
    });
    for (const { n, e } of substitues) sortie = sortie.split(e.valeur).join(`⟦S${n}⟧`);
    return sortie;
  };

  /** Le prélude d'un geste : Vue exacte refusée, repères remis en clair (si la personne y a droit). */
  const prelude = async (entree: Record<string, unknown>, nom: string) => {
    if (visualise) return { refus: REFUS_VUE_EXACTE } as const;
    const s = await substituerReperes(entree, o.coffret, user, acces, nom);
    if ("refus" in s) return { refus: JSON.stringify({ statut: "REFUS", raison: s.refus }) } as const;
    return { entree: s.entree, substitues: s.substitues } as const;
  };

  /** La page et la ligne désignées (dans l'état « virtuel » : les propositions en attente comprises). */
  const cibler = async (e: Record<string, unknown>, avecLigne: boolean) => {
    const ligneRef = texteDe(e, "ligne");
    // Sans `page` et avec plusieurs pages : la seule page qui porte la ligne, le titre `sous` ou la ligne `apres`.
    const indices = [avecLigne ? ligneRef : "", texteDe(e, "apres")].filter(Boolean);
    const sous = texteDe(e, "sous");
    const page = await resoudrePage(user.id, texteDe(e, "page"), indices.length || sous
      ? async (pageId) => {
        const v = await pageVirtuelle(user.id, pageId);
        if (!v) return false;
        return indices.every((r) => resoudreLigne(v.blocs, r).ok) && (!sous || resoudreLigne(v.blocs.filter((b) => b.type === "titre"), sous).ok);
      }
      : undefined);
    if (!page.ok) return { sortie: page.sortie } as const;
    const v = (await pageVirtuelle(user.id, page.pageId)) ?? { blocs: [] as BlocNote[], ajouteesPar: new Map<string, string>() };
    if (!avecLigne) return { page, v, id: "" } as const;
    const r = resoudreLigne(v.blocs, ligneRef);
    if (!r.ok) return { sortie: sortieResolution(r, "ligne") } as const;
    return { page, v, id: r.id } as const;
  };
  const dep = (v: { ajouteesPar: Map<string, string> }, ...ids: (string | null)[]) => ids.flatMap((id) => (id && v.ajouteesPar.has(id) ? [v.ajouteesPar.get(id)!] : []));

  const PAGE = { type: "string", description: "Le titre de la page (ou sa référence) ; facultatif si la personne n'en a qu'une." };
  const LIGNE = { type: "string", description: "La ligne : sa référence ⟨…⟩ rendue par lire_notes (de préférence), ou un morceau de son texte." };
  const OU = {
    sous: { type: "string", description: "Le titre de section sous lequel poser la ligne (à la fin de la section) — « Cette semaine »." },
    apres: { type: "string", description: "La ligne après laquelle la poser (référence ou texte)." },
    en_tete: { type: "boolean", description: "En tête de page." },
  };

  return [
    {
      def: {
        name: "lire_notes",
        description:
          "LIT « Mes notes », le bloc-notes PRIVÉ de la personne (pages, titres, puces, cases à cocher). À appeler SEULEMENT quand la demande porte sur ses notes "
          + "(« qu'est-ce qu'il me reste cette semaine ? », « ajoute à ma liste », « coche… ») — jamais pour répondre à autre chose. Chaque ligne porte sa référence ⟨…⟩ "
          + "pour les gestes. Sans `page` : la liste des pages et leur contenu.",
        input_schema: { type: "object", properties: { page: PAGE } },
      },
      allowed: aSoi,
      label: "Notes consultées",
      run: async (e) => {
        if (visualise) return REFUS_VUE_EXACTE;
        const coffret = o.coffret ?? new CoffretDuTour();
        const ref = texteDe(e, "page");
        let pages = await listerPages(user.id);
        if (ref) {
          const r = await resoudrePage(user.id, ref);
          if (!r.ok) return r.sortie;
          pages = pages.filter((p) => p.id === r.pageId);
          if (!pages.length) return JSON.stringify({ statut: "PROPOSEE_NON_ACCEPTEE", raison: `La page « ${r.titre} » est proposée, pas encore acceptée : elle est vide.` });
        }
        const lignes: string[] = [];
        for (const p of pages) {
          const page = await lirePage(user.id, p.id);
          if (!page) continue;
          lignes.push(`## ${page.titre}  ⟨page ${page.id}⟩${page.blocs.length ? "" : " (vide)"}`, ...lignesPourModele(page.blocs, pourModele(coffret, page.id)));
        }
        const b = borner(lignes);
        let sortie = JSON.stringify({
          pages: pages.map((p) => ({ page: p.titre, ref: p.id, cases: p.cases.total ? `${p.cases.faites}/${p.cases.total} cochées` : undefined })),
          notes: b.lignes.join("\n"),
          ...(b.tronque ? { tronque: "Les notes sont plus longues : demande une page précise (`page`)." } : {}),
          legende: "« # » titre, « - » puce, « [ ] » case à faire, « [x] » case cochée ; l'indentation = sous-liste ; ⟨…⟩ = référence pour les gestes.",
        });
        // Sans coffret (une routine) : aucun repère à révéler — la valeur est masquée.
        if (!o.coffret) sortie = remplacerReperes(sortie, () => MASQUE_CONFIDENTIEL);
        return sortie;
      },
    },
    {
      def: {
        name: "ajouter_note",
        description:
          "PROPOSE d'ajouter une ligne aux notes de la personne (« ajoute X à ma liste », « note que… »). `type` : tache (case à cocher), puce, texte, titre — "
          + "par défaut, le type des lignes voisines. Où : `sous` un titre, `apres` une ligne, `en_tete`, sinon à la fin. RIEN n'est écrit avant que la personne accepte.",
        input_schema: {
          type: "object",
          properties: {
            texte: { type: "string", description: "Le texte de la ligne, tel que la personne l'a dit." },
            type: { type: "string", enum: ["tache", "puce", "texte", "titre"] },
            page: PAGE, ...OU,
          },
          required: ["texte"],
        },
      },
      allowed: aSoi,
      label: "Note proposée",
      run: async (brut) => {
        const pre = await prelude(brut, "ajouter_note");
        if ("refus" in pre) return pre.refus!;
        const e = pre.entree;
        let texte = nettoyerTexte(texteDe(e, "texte")).trim();
        if (!texte) return JSON.stringify({ statut: "INCOMPLET", raison: "Quel texte ajouter ?" });
        const c = await cibler(e, false);
        if ("sortie" in c) return c.sortie!;
        const pos = resoudrePosition(c.v.blocs, { sous: texteDe(e, "sous"), apres: texteDe(e, "apres"), enTete: e.en_tete === true });
        if (!pos.ok) return sortieResolution(pos.resolution as Exclude<Resolution, { ok: true }>, pos.quoi);
        const voisin = c.v.blocs.find((x) => x.id === pos.apres);
        let type: TypeBloc = estTypeBloc(e.type) ? e.type : voisin && (voisin.type === "tache" || voisin.type === "puce") ? voisin.type : "puce";
        let fait = false;
        // « - acheter », « [] appeler » : le raccourci de l'éditeur vaut aussi à l'oral.
        const r = raccourci({ id: "x", type: "texte", texte, niveau: 0 });
        if (r) { type = r.type; texte = r.texte; fait = r.fait === true; }
        const bloc: BlocNote = { id: nouvelIdBloc(), type, texte, niveau: type === "titre" ? 0 : pos.niveau, ...(type === "tache" ? { fait } : {}) };
        const g: GesteNote = { geste: "ajouter_note", pageId: c.page.pageId, bloc, apres: pos.apres };
        return proposerEtDire(g, c.page.titre, { sous: pos.sous }, [...c.page.dependDe, ...dep(c.v, pos.apres)], pre.substitues);
      },
    },
    {
      def: {
        name: "modifier_note",
        description: "PROPOSE de réécrire le texte d'une ligne des notes. Désigne la ligne par sa référence (lire_notes d'abord). RIEN n'est écrit avant que la personne accepte.",
        input_schema: { type: "object", properties: { ligne: LIGNE, texte: { type: "string", description: "Le nouveau texte, entier." }, page: PAGE }, required: ["ligne", "texte"] },
      },
      allowed: aSoi,
      label: "Note proposée",
      run: async (brut) => {
        const pre = await prelude(brut, "modifier_note");
        if ("refus" in pre) return pre.refus!;
        const texte = nettoyerTexte(texteDe(pre.entree, "texte")).trim();
        if (!texte) return JSON.stringify({ statut: "INCOMPLET", raison: "Quel nouveau texte ? (pour retirer la ligne : supprimer_note)" });
        const c = await cibler(pre.entree, true);
        if ("sortie" in c) return c.sortie!;
        const ancien = c.v.blocs.find((x) => x.id === c.id)!.texte;
        if (ancien === texte) return JSON.stringify({ statut: "INCHANGE", raison: "La ligne porte déjà ce texte." });
        return proposerEtDire({ geste: "modifier_note", pageId: c.page.pageId, id: c.id, texte, ancien }, c.page.titre, {}, [...c.page.dependDe, ...dep(c.v, c.id)], pre.substitues);
      },
    },
    {
      def: {
        name: "cocher_note",
        description: "PROPOSE de cocher (fait) ou décocher une case des notes — « c'est fait », « coche… ». Une ligne qui n'est pas une case le devient. RIEN n'est écrit avant que la personne accepte.",
        input_schema: { type: "object", properties: { ligne: LIGNE, fait: { type: "boolean", description: "true = cocher (défaut), false = décocher." }, page: PAGE }, required: ["ligne"] },
      },
      allowed: aSoi,
      label: "Note proposée",
      run: async (brut) => {
        const pre = await prelude(brut, "cocher_note");
        if ("refus" in pre) return pre.refus!;
        const c = await cibler(pre.entree, true);
        if ("sortie" in c) return c.sortie!;
        const fait = pre.entree.fait !== false;
        const b = c.v.blocs.find((x) => x.id === c.id)!;
        if (b.type === "tache" && !!b.fait === fait) return JSON.stringify({ statut: "INCHANGE", raison: fait ? "Elle est déjà cochée." : "Elle n'est pas cochée." });
        return proposerEtDire({ geste: "cocher_note", pageId: c.page.pageId, id: c.id, fait }, c.page.titre, { blocs: c.v.blocs }, [...c.page.dependDe, ...dep(c.v, c.id)], pre.substitues);
      },
    },
    {
      def: {
        name: "deplacer_note",
        description: "PROPOSE de déplacer une ligne (et ses sous-lignes) dans sa page : `sous` un titre, `apres` une ligne, ou `en_tete`. RIEN n'est écrit avant que la personne accepte.",
        input_schema: { type: "object", properties: { ligne: LIGNE, page: PAGE, ...OU }, required: ["ligne"] },
      },
      allowed: aSoi,
      label: "Note proposée",
      run: async (brut) => {
        const pre = await prelude(brut, "deplacer_note");
        if ("refus" in pre) return pre.refus!;
        const e = pre.entree;
        const c = await cibler(e, true);
        if ("sortie" in c) return c.sortie!;
        if (!texteDe(e, "sous") && !texteDe(e, "apres") && e.en_tete !== true) return JSON.stringify({ statut: "INCOMPLET", raison: "Où la déplacer : `sous` un titre, `apres` une ligne, ou `en_tete` ?" });
        const pos = resoudrePosition(c.v.blocs, { sous: texteDe(e, "sous"), apres: texteDe(e, "apres"), enTete: e.en_tete === true });
        if (!pos.ok) return sortieResolution(pos.resolution as Exclude<Resolution, { ok: true }>, pos.quoi);
        if (pos.apres === c.id) return JSON.stringify({ statut: "INCHANGE", raison: "La ligne est déjà à cet endroit." });
        const avant = c.v.blocs[c.v.blocs.findIndex((x) => x.id === c.id) - 1]?.id ?? null;
        return proposerEtDire({ geste: "deplacer_note", pageId: c.page.pageId, id: c.id, apres: pos.apres, avant }, c.page.titre, { blocs: c.v.blocs }, [...c.page.dependDe, ...dep(c.v, c.id, pos.apres)], pre.substitues);
      },
    },
    {
      def: {
        name: "supprimer_note",
        description: "PROPOSE de supprimer UNE ligne des notes (ses sous-lignes restent). Une ligne supprimée reste 30 jours à la corbeille. RIEN n'est écrit avant que la personne accepte.",
        input_schema: { type: "object", properties: { ligne: LIGNE, page: PAGE }, required: ["ligne"] },
      },
      allowed: aSoi,
      label: "Note proposée",
      run: async (brut) => {
        const pre = await prelude(brut, "supprimer_note");
        if ("refus" in pre) return pre.refus!;
        const c = await cibler(pre.entree, true);
        if ("sortie" in c) return c.sortie!;
        const i = c.v.blocs.findIndex((x) => x.id === c.id);
        return proposerEtDire({ geste: "supprimer_note", pageId: c.page.pageId, id: c.id, bloc: c.v.blocs[i], apres: c.v.blocs[i - 1]?.id ?? null }, c.page.titre, {}, [...c.page.dependDe, ...dep(c.v, c.id)], pre.substitues);
      },
    },
    {
      def: {
        name: "creer_page",
        description: "PROPOSE de créer une nouvelle page de notes (« fais-moi une page Congrès d'Oran »). On peut y proposer des lignes aussitôt (ajouter_note avec `page`). RIEN n'est écrit avant que la personne accepte.",
        input_schema: { type: "object", properties: { titre: { type: "string" } }, required: ["titre"] },
      },
      allowed: aSoi,
      label: "Page proposée",
      run: async (brut) => {
        const pre = await prelude(brut, "creer_page");
        if ("refus" in pre) return pre.refus!;
        const titre = nettoyerTitrePage(texteDe(pre.entree, "titre"));
        if (!titre) return JSON.stringify({ statut: "INCOMPLET", raison: "Quel nom pour la page ?" });
        const memes = (await listerPages(user.id)).filter((p) => plierNote(p.titre) === plierNote(titre));
        if (memes.length) return JSON.stringify({ statut: "EXISTE", raison: `La page « ${memes[0].titre} » existe déjà.`, ref: memes[0].id });
        return proposerEtDire({ geste: "creer_page", pageId: nouvelIdPage(), titre }, titre, {}, [], pre.substitues);
      },
    },
    {
      def: {
        name: "renommer_page",
        description: "PROPOSE de renommer une page de notes. RIEN n'est écrit avant que la personne accepte.",
        input_schema: { type: "object", properties: { page: PAGE, titre: { type: "string", description: "Le nouveau nom." } }, required: ["page", "titre"] },
      },
      allowed: aSoi,
      label: "Page proposée",
      run: async (brut) => {
        const pre = await prelude(brut, "renommer_page");
        if ("refus" in pre) return pre.refus!;
        const titre = nettoyerTitrePage(texteDe(pre.entree, "titre"));
        if (!titre) return JSON.stringify({ statut: "INCOMPLET", raison: "Quel nouveau nom ?" });
        const p = await resoudrePage(user.id, texteDe(pre.entree, "page"));
        if (!p.ok) return p.sortie;
        if (p.titre === titre) return JSON.stringify({ statut: "INCHANGE", raison: "La page porte déjà ce nom." });
        return proposerEtDire({ geste: "renommer_page", pageId: p.pageId, titre, ancien: p.titre }, p.titre, {}, p.dependDe, pre.substitues);
      },
    },
  ];
}
