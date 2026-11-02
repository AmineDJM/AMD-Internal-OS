import { empreinte, jours, montantLisible, type ContenuRecette, type EtapePlanRecette } from "./contenu";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE PLAN TIRÉ D'UNE RECETTE (J10, décision 0028) — pur.
 *
 * Une recette VALIDÉE devient un gabarit de plan de travail (J2, `missions/travaux/plan.ts`) : l'assistant le propose
 * tel quel à `lancer_un_travail`, la personne l'approuve (ou le retouche). Le gabarit n'invente aucun geste : il n'y a
 * que des étapes que tout catalogue accepte (ANALYSE, ATTENTE à la minuterie, LIVRABLE) — le dépôt lui-même reste une
 * carte confirmée dans la conversation. Une recette de TRAVAUX rend la forme du plan qui a réussi.
 *
 * Les ÉCARTS sont dits, jamais corrigés en silence : un montant au-dessus d'un seuil (« la DG signera »), un délai
 * demandé plus court que la médiane, une étape du gabarit retirée ou ajoutée par le modèle.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PlanRecette {
  titre: string;
  objectif: string;
  etapes: EtapePlanRecette[];
}

export interface Validation {
  version: number;
  par: string;
  le: string;
}

/** « selon la recette validée par Samia Benali le 12/10/2026 » — la phrase que l'assistant reprend. */
export const phraseValidation = (titre: string, v: Validation): string =>
  `selon la recette « ${titre} » (version ${v.version}) validée par ${v.par} le ${v.le.slice(8, 10)}/${v.le.slice(5, 7)}/${v.le.slice(0, 4)}`;

export function planDeLaRecette(c: ContenuRecette, v: Validation, intention: string): PlanRecette | null {
  const objectif = `${intention.trim().slice(0, 600)} — ${phraseValidation(c.titre, v)}.`;
  const titre = `${c.titre} — selon la recette`.slice(0, 120);
  if (c.formePlan?.length) return { titre, objectif, etapes: c.formePlan.map((e) => ({ ...e })) };
  if (!c.etapes.length || c.duree.medianeJours === null) return null;

  const pieces = c.pieces.length ? c.pieces.map((p) => p.nature.toLowerCase().replace(/_/g, " ")).join(", ") : "aucune pièce habituelle relevée";
  const circuit = c.etapes.map((e) => `${e.libelle}${e.condition ? ` (${e.condition})` : ""}`).join(" → ");
  const pieges = c.pieges.map((p) => p.texte).join(" ; ") || "aucun piège fréquent relevé";
  const lente = [...c.etapes].filter((e) => e.dureeMedianeJours !== null).sort((a, b) => (b.dureeMedianeJours ?? 0) - (a.dureeMedianeJours ?? 0))[0];
  const attente = Math.min(180, Math.max(1, Math.ceil(c.duree.medianeJours)));
  return {
    titre,
    objectif,
    etapes: [
      {
        cle: "preparer", type: "ANALYSE", titre: "Préparer la demande selon la recette",
        consigne: `Vérifier que la demande réunit les pièces habituelles (${pieces}) et éviter les pièges connus : ${pieges}.`,
      },
      {
        cle: "fiche", type: "LIVRABLE", titre: "Fiche de dépôt : pièces, circuit et validateurs", apres: ["preparer"],
        consigne: `Rédiger la fiche de dépôt : le circuit (${circuit})${c.seuils.length ? `, les seuils (${c.seuils.map((s) => s.texte).join(" ; ")})` : ""}, les pièces à joindre, ce qui manque encore.`,
      },
      {
        cle: "point-median", type: "ATTENTE", titre: `Point à ${jours(c.duree.medianeJours)} (durée médiane du circuit)`, apres: ["fiche"],
        attente: { jours: attente },
      },
      {
        cle: "point", type: "LIVRABLE", titre: "Point d'étape : où en est la demande, quoi relancer", apres: ["point-median"],
        consigne: `Faire le point : étape atteinte, ce qui bloque${lente ? ` (l'étape la plus lente est « ${lente.libelle} », médiane ${jours(lente.dureeMedianeJours)})` : ""}, la relance à faire et à qui.`,
      },
    ],
  };
}

/** La signature d'un plan : ce que la personne approuve. Les titres et consignes reformulés n'en font pas partie. */
export function signaturePlan(plan: { etapes?: unknown } | null | undefined): string | null {
  const etapes = Array.isArray(plan?.etapes) ? (plan!.etapes as Record<string, unknown>[]) : null;
  if (!etapes?.length) return null;
  return empreinte(JSON.stringify(etapes.map((e) => [
    String(e.cle ?? "").toLowerCase(), String(e.type ?? "").toUpperCase(), String(e.outil ?? ""),
    Array.isArray(e.apres) ? [...e.apres].map(String).sort() : [],
    e.attente && typeof e.attente === "object" ? [(e.attente as Record<string, unknown>).evenement ?? "", (e.attente as Record<string, unknown>).jours ?? 0, (e.attente as Record<string, unknown>).minutes ?? 0] : null,
    e.si && typeof e.si === "object" ? [(e.si as Record<string, unknown>).etape ?? "", String((e.si as Record<string, unknown>).issue ?? "").toUpperCase()] : null,
  ])));
}

/** Ce qui sépare un plan proposé du gabarit de la recette — étapes retirées, ajoutées, changées. */
export function ecartsAuPlan(gabarit: PlanRecette, propose: { etapes?: unknown }): string[] {
  const ecarts: string[] = [];
  const brutes = Array.isArray(propose.etapes) ? (propose.etapes as Record<string, unknown>[]) : [];
  const parCle = new Map(brutes.map((e) => [String(e.cle ?? "").toLowerCase(), e]));
  const cles = new Set(gabarit.etapes.map((e) => e.cle));
  for (const e of gabarit.etapes) {
    const p = parCle.get(e.cle);
    if (!p) { ecarts.push(`étape de la recette retirée : « ${e.titre} »`); continue; }
    if (String(p.type ?? "").toUpperCase() !== e.type) ecarts.push(`« ${e.titre} » change de nature (${e.type} → ${String(p.type)})`);
    const ja = e.attente?.jours ?? null;
    const jp = p.attente && typeof p.attente === "object" ? (p.attente as Record<string, unknown>).jours ?? null : null;
    if (ja !== null && jp !== ja) ecarts.push(`« ${e.titre} » : attente de ${String(jp ?? "—")} j au lieu de ${ja} j`);
  }
  for (const [cle, p] of parCle) if (!cles.has(cle)) ecarts.push(`étape ajoutée hors recette : « ${String(p.titre ?? cle)} »`);
  return ecarts;
}

const MULTIPLICATEURS: Record<string, number> = { m: 1_000_000, million: 1_000_000, millions: 1_000_000, k: 1_000, mille: 1_000 };

/** Le montant cité dans une demande (« 2,5 M DZD », « 1 200 000 DA », « 800 000 dinars ») — ou rien. */
export function montantCite(texte: string): number | null {
  const re = /(\d{1,3}(?:[   .]\d{3})+|\d+(?:[.,]\d+)?)\s*(m(?!\p{L})|millions?(?!\p{L})|k(?!\p{L})|mille(?!\p{L}))?\s*(?:dzd|da(?!\p{L})|dinars?)?/giu;
  let meilleur: number | null = null;
  for (const m of texte.matchAll(re)) {
    const brut = m[1];
    const groupe = /[   .]\d{3}/.test(brut) && !/,/.test(brut);
    const valeur = groupe ? Number(brut.replace(/[   .]/g, "")) : Number(brut.replace(",", "."));
    const mult = m[2] ? MULTIPLICATEURS[m[2].toLowerCase()] ?? 1 : 1;
    const v = valeur * mult;
    const devise = /dzd|da(?!\p{L})|dinar/iu.test(m[0]) || !!m[2];
    if (!Number.isFinite(v) || (!devise && v < 10_000)) continue;
    if (meilleur === null || v > meilleur) meilleur = v;
  }
  return meilleur;
}

/** Le délai demandé (« sous 3 jours », « dans 2 semaines ») — en jours, ou rien. */
export function delaiCite(texte: string): number | null {
  const m = texte.toLowerCase().match(/(?:sous|dans|en|d'ici)\s+(\d+)\s*(jours?|j\b|semaines?)/);
  if (!m) return null;
  return Number(m[1]) * (m[2].startsWith("semaine") ? 7 : 1);
}

/** Les écarts d'une DEMANDE à la recette : un seuil franchi, un délai plus court que d'habitude. */
export function ecartsALaDemande(c: ContenuRecette, intention: string): string[] {
  const ecarts: string[] = [];
  const montant = montantCite(intention);
  if (montant !== null) {
    for (const s of c.seuils) {
      if (montant > s.montant) ecarts.push(`montant de ${montantLisible(montant)} au-delà du seuil de ${montantLisible(s.montant)} : l'étape « ${s.libelle} » s'applique`);
      else if (s.source === "DEFINITION") ecarts.push(`montant de ${montantLisible(montant)} sous le seuil de ${montantLisible(s.montant)} : « ${s.libelle} » sera franchie automatiquement`);
    }
  }
  const delai = delaiCite(intention);
  if (delai !== null && c.duree.medianeJours !== null && delai < c.duree.medianeJours) {
    ecarts.push(`délai demandé (${delai} j) plus court que la durée médiane du circuit (${jours(c.duree.medianeJours)}) : prévenir les validateurs tôt`);
  }
  return ecarts;
}
