/**
 * `regulatory_intelligence` / `legal_intelligence` / `finance_intelligence` — Adam répond « qu'est-ce
 * qui cloche dans nos dossiers, nos contrats, nos budgets ? » depuis les règles de l'intelligence
 * métier (mandat 4 §27), jamais de mémoire : des SIGNAUX datés, gradués, chacun avec son calcul et
 * sa fiche. Sous les droits de la personne — la même porte que l'écran.
 *
 * Les outils LISENT. Relancer un fournisseur, dénoncer un contrat, régler un paiement restent des
 * gestes humains (ou des actions confirmées) : un signal dit ce qu'il y a à FAIRE, il ne le fait pas.
 */

import type { PowerTool } from "@/platform/ia/outil";
import { faitCalcule, declarerProvenance } from "@/platform/in-process/fabric/provenance";
import {
  peutLireFinance, peutLireLegal, peutLireRegulatory, signauxFinance, signauxLegal, signauxRegulatory,
  LIBELLE_GRAVITE, type LectureIntelligence, type Signal,
} from "@/platform/in-process/intelligence";
import { formatMontant } from "@/lib/utils";

type Acteur = Parameters<PowerTool["run"]>[1];

const str = (input: Record<string, unknown>, key: string): string => (typeof input[key] === "string" ? (input[key] as string).trim() : "");
const num = (input: Record<string, unknown>, key: string, defaut: number, min: number, max: number): number =>
  typeof input[key] === "number" && Number.isFinite(input[key] as number) ? Math.max(min, Math.min(max, Math.round(input[key] as number))) : defaut;

const GRAVITES = ["CRITIQUE", "HAUTE", "NORMALE", "BASSE"] as const;

function blocSignaux(titre: string, signaux: readonly Signal[]): Record<string, unknown> | null {
  if (!signaux.length) return null;
  return {
    kind: "table", title: titre,
    columns: [
      { key: "gravite", label: "gravité", numeric: false }, { key: "signal", label: "signal", numeric: false },
      { key: "echeance", label: "échéance", numeric: false }, { key: "montant", label: "montant (DZD)", numeric: true }, { key: "calcul", label: "calcul", numeric: false },
    ],
    rows: signaux.slice(0, 40).map((s) => ({ cells: {
      gravite: LIBELLE_GRAVITE[s.gravite], signal: s.titre, echeance: s.echeance ?? "—",
      montant: s.montant != null ? formatMontant(s.montant) : "—", calcul: s.calcul ?? "—",
    } })),
    total: signaux.length,
  };
}

function reponse(user: Acteur, outil: string, l: LectureIntelligence, input: Record<string, unknown>): string {
  const filtreGravite = GRAVITES.includes(str(input, "gravite") as (typeof GRAVITES)[number]) ? (str(input, "gravite") as Signal["gravite"]) : null;
  const code = str(input, "code");
  const limite = num(input, "limite", 30, 1, 60);
  const retenus = l.signaux.filter((s) => (!filtreGravite || s.gravite === filtreGravite) && (!code || s.code === code));
  const parCode: Record<string, number> = {};
  for (const s of l.signaux) parCode[s.code] = (parCode[s.code] ?? 0) + 1;
  // PAR ENTITÉ : chaque dossier, contrat ou enveloppe touché, avec sa pire gravité et ses codes —
  // pour que « quels dossiers sont en retard ? » cite TOUS les dossiers, pas les trente premiers signaux.
  const parEntite = new Map<string, { entite: string; type: string; gravite: Signal["gravite"]; codes: string[]; faits: string[]; fiche: string | null }>();
  for (const s of retenus) {
    if (!s.entite) continue;
    const cle = `${s.entite.type}:${s.entite.id}`;
    // Le FAIT par entité : le titre du signal, qui porte le chiffre (« Étape en retard de 40 j — dépôt »),
    // sans la répétition du nom de l'entité — c'est ce qu'une réponse « pour chacun » doit citer.
    const fait = s.titre.replace(new RegExp(`\\s*:\\s*${(s.entite.ref ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}.*$`), "");
    const e = parEntite.get(cle);
    if (!e) parEntite.set(cle, { entite: s.entite.ref ?? s.entite.id, type: s.entite.type, gravite: s.gravite, codes: [s.code], faits: [fait], fiche: s.href ?? null });
    else { if (!e.codes.includes(s.code)) e.codes.push(s.code); if (e.faits.length < 4 && !e.faits.includes(fait)) e.faits.push(fait); }
  }
  const titre = `${l.domaine === "REGULATORY" ? "Regulatory" : l.domaine === "LEGAL" ? "Legal" : "Finance"} — ${l.resume.phrase}`;
  const bloc = blocSignaux(titre, retenus);
  return JSON.stringify({
    source: `règles déterministes de l'intelligence ${l.domaine} (lecture ERP sous vos droits, calcul à ${l.calculeLe.slice(0, 16).replace("T", " ")} UTC, ${l.ms} ms)`,
    resume: l.resume.phrase,
    parGravite: l.resume.parGravite,
    parCode,
    portee: l.portee,
    limites: l.notes,
    filtre: [filtreGravite ? `gravité ${LIBELLE_GRAVITE[filtreGravite]}` : null, code ? `code ${code}` : null].filter(Boolean).join(" · ") || "tout",
    signaux: retenus.slice(0, limite).map((s) => ({
      gravite: s.gravite, code: s.code, titre: s.titre, detail: s.detail, calcul: s.calcul ?? null, echeance: s.echeance ?? null,
      // LE MARQUEUR VOYAGE AVEC LE SIGNAL. Sans cette ligne, `lireSignauxDeSortie` relirait des
      // signaux dont le geste déclaré a disparu en route, et le tour ne proposerait jamais rien —
      // le mécanisme serait écrit, testé, et sans effet en production (§118.14).
      ...(s.tache ? { tache: true as const } : {}),
      montant: s.montant != null ? Math.round(s.montant) : null, entite: s.entite ?? null, fiche: s.href ?? null, aFaire: s.action ?? null,
    })),
    parEntite: [...parEntite.values()].slice(0, 80),
    tronque: retenus.length > limite ? `${retenus.length - limite} signal(aux) de plus — préciser gravite ou code, ou lire parEntite` : null,
    consigne: "Chaque signal porte son calcul : le citer tel quel. Ne rien conclure au-delà des signaux ; « rien à signaler » se dit avec la portée lue.",
    _blocs: bloc ? [bloc] : [],
    _blocsDecoratifs: true,
    _provenance: declarerProvenance([faitCalcule({
      outil, acteur: user.id, libelle: titre, valeur: l.signaux.length,
      entrees: Object.entries(l.portee).map(([k, v]) => `${k} : ${v}`), transformation: "règles déterministes datées (gravité, échéance, calcul)", formule: l.resume.phrase,
    })]),
  });
}

const proprietesCommunes = {
  gravite: { type: "string", enum: [...GRAVITES], description: "Ne montrer qu'une gravité. Optionnel." },
  code: { type: "string", description: "Ne montrer qu'un code de signal (voir `parCode` d'une première lecture). Optionnel." },
  limite: { type: "number", description: "Nombre de signaux détaillés (défaut 20, max 60)." },
} as const;

export const INTELLIGENCE_TOOLS: PowerTool[] = [
  {
    def: {
      name: "regulatory_intelligence",
      description:
        "LES SIGNAUX REGULATORY, calculés par des règles sur les dossiers visibles : étapes bloquées ou en retard (avec le nombre de jours), "
        + "pièces manquantes, dépôts dont la date cible est passée ou proche, partenaires/fournisseurs en retard sur ce qu'on attend d'eux, "
        + "réponses aux questions de l'agence attendues, dossiers sans activité ; et, dans l'espace d'analyse CTD : bloqueurs de soumission, "
        + "réserves ouvertes sans réponse, demandes fournisseur à relancer, obligations (CPP, GMP, AMM…) échues ou proches. Chaque signal dit "
        + "son calcul, son échéance et sa fiche. À appeler pour « quels dossiers sont en retard ? », « qu'est-ce qui bloque le dossier X ? », "
        + "« qui faut-il relancer ? ». Ne relance rien : la relance est un geste humain.",
      input_schema: {
        type: "object",
        properties: {
          ...proprietesCommunes,
          filtre: { type: "string", description: "Référence, DCI, marque ou partenaire pour restreindre. Optionnel." },
          horizonJours: { type: "number", description: "Horizon des échéances à venir (défaut 30)." },
        },
      },
    },
    allowed: (u) => peutLireRegulatory(u),
    label: "Signaux Regulatory calculés",
    run: async (input, user) => reponse(user, "regulatory_intelligence", await signauxRegulatory(user, { filtre: str(input, "filtre") || null, horizonJours: num(input, "horizonJours", 30, 1, 180) }), input),
  },
  {
    def: {
      name: "legal_intelligence",
      description:
        "LES SIGNAUX LEGAL, calculés par des règles sur les engagements ACTIFS visibles et les CLAUSES lues dans leur texte : échéances "
        + "(dépassée / imminente / proche), date limite de DÉNONCIATION = fin − préavis quand le contrat se reconduit tacitement, reconduction "
        + "acquise faute de dénonciation, obligations après terme (confidentialité, non-concurrence, exclusivité), avenants comparés clause par "
        + "clause (durée, pénalités, exclusivité…), risques (pénalité sans plafond, tacite sans préavis, droit étranger, responsabilité illimitée). "
        + "Chaque signal cite son calcul et l'extrait de clause. À appeler pour « quels contrats arrivent à échéance ? », « quand faut-il dénoncer "
        + "le contrat X ? », « quels risques dans nos contrats ? ». Un contrat sans texte indexé est dit « sans texte » : rien n'est inventé.",
      input_schema: {
        type: "object",
        properties: {
          ...proprietesCommunes,
          filtre: { type: "string", description: "Titre, contrepartie ou référence pour restreindre. Optionnel." },
          horizonJours: { type: "number", description: "Horizon des échéances à venir (défaut 90)." },
        },
      },
    },
    allowed: (u) => peutLireLegal(u),
    label: "Signaux Legal calculés",
    run: async (input, user) => reponse(user, "legal_intelligence", await signauxLegal(user, { filtre: str(input, "filtre") || null, horizonJours: num(input, "horizonJours", 90, 7, 365) }), input),
  },
  {
    def: {
      name: "finance_intelligence",
      description:
        "LES SIGNAUX FINANCE, calculés par des règles : enveloppes budgétaires consommées plus vite que le calendrier (rythme, projection "
        + "d'atterrissage, écart projeté), dépassements, catégories dépassées ; ordres de dépense réglés ou à régler SANS la facture exigée ; "
        + "échéances de paiement selon leur nature (date imposée / importante / modérée) ; factures sans bon de commande, BC sans facture, "
        + "facture qui s'écarte de son devis ou BC. Chaque signal porte son calcul (« 62 % consommé à 41 % du temps »). À appeler pour "
        + "« où en sont nos budgets ? », « qu'est-ce qui cloche côté paiements ? », « quels justificatifs manquent ? ». Ne règle rien.",
      input_schema: { type: "object", properties: { ...proprietesCommunes, horizonJours: { type: "number", description: "Horizon des échéances de paiement (défaut 30)." } } },
    },
    allowed: (u) => peutLireFinance(u),
    label: "Signaux Finance calculés",
    run: async (input, user) => reponse(user, "finance_intelligence", await signauxFinance(user, { horizonJours: num(input, "horizonJours", 30, 1, 180) }), input),
  },
];

/**
 * LA LECTURE, À CÔTÉ DE SON ÉCRITURE — pour que le tour retrouve ses signaux.
 *
 * Le geste déclaré (§118.126) est décidé par du code PUR (`gesteDuTour`), qui a besoin des
 * signaux STRUCTURÉS ; la boucle, elle, ne garde que la chaîne JSON que `reponse` a écrite.
 * Deux issues : faire remonter les signaux par un canal parallèle, ou relire la sortie. La
 * première créerait une seconde vérité sur « ce que ce tour a lu », et c'est celle qui prendrait
 * du retard au premier champ ajouté (§118.5). La seconde est sûre à UNE condition : que le
 * lecteur vive DANS le fichier qui écrit, donc que les deux bougent ensemble.
 *
 * Il ne jette jamais : une sortie qui n'est pas la nôtre, un JSON illisible, une forme
 * inattendue rendent une liste VIDE — et une liste vide ne propose rien (§118.16).
 */
export function lireSignauxDeSortie(sortie: string): Signal[] {
  if (!sortie.startsWith("{") || !sortie.includes('"signaux"')) return [];
  try {
    const objet = JSON.parse(sortie) as { signaux?: unknown };
    if (!Array.isArray(objet.signaux)) return [];
    return objet.signaux.flatMap((brut) => {
      if (!brut || typeof brut !== "object") return [];
      const f = brut as Record<string, unknown>;
      if (typeof f.code !== "string" || typeof f.gravite !== "string" || typeof f.titre !== "string") return [];
      return [{
        code: f.code,
        gravite: f.gravite as Signal["gravite"],
        titre: f.titre,
        detail: typeof f.detail === "string" ? f.detail : "",
        ...(typeof f.calcul === "string" ? { calcul: f.calcul } : {}),
        ...(typeof f.echeance === "string" ? { echeance: f.echeance } : {}),
        ...(typeof f.montant === "number" ? { montant: f.montant } : {}),
        ...(f.entite && typeof f.entite === "object" ? { entite: f.entite as Signal["entite"] } : {}),
        // LES DEUX NOMS QUI DIFFÈRENT — et c'était la cause de ZÉRO carte (§118.127).
        // La sortie est écrite pour le MODÈLE, qui lit du français : `action` y devient `aFaire`
        // et `href` y devient `fiche`. Le prédicat d'avant s'écrivait `(s): s is Signal` sur
        // trois `typeof` et AFFIRMAIT donc un type qu'il ne prouvait pas : tout signal relu
        // portait `action: undefined`, et `gesteDuTour` les refusait TOUS — marqueur posé ou non.
        // On TRADUIT champ par champ (§118.34), et plus aucun cast n'affirme plus qu'il ne lit.
        ...(typeof f.aFaire === "string" && f.aFaire.length > 0 ? { action: f.aFaire } : {}),
        ...(typeof f.fiche === "string" ? { href: f.fiche } : {}),
        ...(f.tache === true ? { tache: true as const } : {}),
      } satisfies Signal];
    });
  } catch {
    return [];
  }
}
