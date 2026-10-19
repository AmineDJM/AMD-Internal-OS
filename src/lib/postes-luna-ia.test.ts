import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LUNA PROPOSE LES POSTES D'UNE DEMANDE — le banc, modèle SIMULÉ AU NIVEAU DE LA PASSERELLE.
 *
 * Seul le monde extérieur est simulé : le fournisseur (`askModelJson`, qui rend la réponse qu'un
 * modèle donnerait à chaque description), l'interrupteur et la bascule (lignes globales), la présence
 * d'une clé. Le chemin réel tourne : portes, prompt, relecture stricte, lecture des fiches par les
 * règles du formulaire (`lireFichesDuFormulaire`), journal.
 *
 * Quatre descriptions : l'exemple réel de la Direction (Advisory Board, Hyatt Regency), une seule
 * personne, des dates en toutes lettres, une demande sans billetterie.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const APPELS: { prompt: string; system?: string }[] = [];
let REPONSE: (prompt: string) => unknown = () => null;
let PANNE = false;
vi.mock("@/lib/models/gateway", () => ({
  askModelJson: async (role: string, prompt: string, _schema: unknown, opts: { system?: string }) => {
    APPELS.push({ prompt, system: opts.system });
    if (PANNE) throw new Error("réseau");
    return {
      data: REPONSE(prompt),
      reply: { ok: true, configured: true, stop: "end", blocks: [], usage: { role, model: "modele-du-banc", provider: "openai", inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, costUsd: 0, ms: 1, attempts: 1 } },
    };
  },
}));

let COUPEE = false;
let ACTIVE = true;
const JOURNAL: { feature: string; ok: boolean; errorCode: string | null }[] = [];
vi.mock("@/lib/ai-settings", async (orig) => ({
  ...(await orig<typeof import("@/lib/ai-settings")>()),
  interrupteurIaCoupe: async () => COUPEE,
  aiFeatureEnabled: async () => ACTIVE,
  logAiUsage: async (u: { feature: string; ok: boolean; errorCode: string | null }) => { JOURNAL.push(u); },
}));
let CONFIGUREE = true;
vi.mock("@/lib/ai", async (orig) => ({ ...(await orig<typeof import("@/lib/ai")>()), aiConfigured: () => CONFIGUREE, cleModeleRequise: () => "OPENAI_API_KEY" }));

import { proposerPostesParModele, aujourdhuiLisible } from "./postes-luna-ia";
import { lirePropositionModele, versFormulairePoste, type PostePropose } from "@/lib/ad-pro/postes-luna";
import { lireFichesDuFormulaire } from "@/lib/ad-pro/fiches-poste";

const AUJOURDHUI = new Date("2026-10-19T09:00:00.000Z");

// ─────────────────────────────── Les descriptions ───────────────────────────────

const ADVISORY = `Bonjour Radia, Nous prévoyons d'organiser une réunion médicale « Advisory Board » réunissant des experts en hématologie. À cet effet, je te sollicite pour la coordination des prestations suivantes :
1. Réservation d'une salle de réunion : Lieu : Hyatt Regency Alger • Date : Jeudi 5 novembre 2026 • Horaire : de 13h00 à 19h00 • Capacité : 9 pax • 1 cocktail de bienvenue + une pause-café pour 9 pax • Restauration : Déjeuner pour 2 personnes + Dîner à l'hôtel pour 9 pax.
2. Hébergement : Une nuitée en chambre single la nuit du 5 novembre au niveau de l'hotel Hyatt Regency : Nabil Yafour ; Malika Allouda
3. Billetterie : Nabil Yafour — Aller : Oran – Alger, le 5 novembre, vol le matin. Retour : Alger – Oran, le 6 novembre, vol le matin. Habiba Mehnaoui — Aller : Annaba – Alger, le 5 novembre, vol le matin. Retour : Alger – Annaba, le 5 novembre au soir, le vol de 21h00.
Merci par avance, Ps: Je joindrai les PI pour la billetterie ASAP`;

const UNE_PERSONNE = "Bonjour, pour la journée scientifique de cardiologie du 12 décembre 2026 au Sheraton Club des Pins (Alger), merci de réserver un billet d'avion aller simple Constantine – Alger le 11 décembre, vol du soir, pour le Dr Samir Bouzid.";

const EN_LETTRES = "Staff de pneumologie le vingt-trois janvier deux mille vingt-sept au CHU Mustapha d'Alger. Merci de prévoir deux nuitées à l'hôtel El Aurassi, du vingt-deux au vingt-quatre janvier, chambre double, pour le Pr Karim Haddad, ainsi qu'un déjeuner pour quinze personnes le jour du staff.";

const SANS_BILLETTERIE = "Réunion d'experts en oncologie à Oran, hôtel Méridien, le 3 décembre 2026 de 9h00 à 13h00 : salle pour 20 personnes avec pause-café, puis déjeuner pour 20 convives au restaurant de l'hôtel. Pas d'hébergement ni de billetterie, les participants sont locaux.";

// ─────────────────────────────── Ce qu'un modèle rendrait ───────────────────────────────

const ev = (o: Record<string, unknown>) => ({
  nom: "", type: "", portee: "", format: "", dateDebut: "", dateFin: "", horaire: "", lieu: "", ville: "", pays: "", specialite: "", capacite: 0, ...o,
});
const poste = (o: Record<string, unknown>) => ({
  nature: "OTHER", libelle: "", detail: "", personnes: 0, hotel: "", ville: "", dateArrivee: "", dateDepart: "", typeChambre: "", beneficiaires: [], piecesAttendues: [], ...o,
});
const trajet = (de: string, vers: string, date: string, creneau = "") => ({ de, vers, date, creneau });

const MODELE_ADVISORY = {
  evenement: ev({
    nom: "Advisory Board — hématologie", type: "ROUND_TABLE", portee: "NATIONAL", format: "PRESENTIAL", dateDebut: "2026-11-05", dateFin: "2026-11-05",
    horaire: "13h00–19h00", lieu: "Hyatt Regency Alger", ville: "Alger", pays: "Algérie", specialite: "Hématologie", capacite: 9,
  }),
  postes: [
    poste({ nature: "VENUE", libelle: "Salle de réunion — Hyatt Regency Alger", detail: "05/11/2026, 13h00–19h00, capacité 9 pax ; cocktail de bienvenue + pause-café pour 9 pax", personnes: 9 }),
    poste({ nature: "DINNER", libelle: "Restauration — Hyatt Regency Alger", detail: "05/11/2026 : déjeuner pour 2 personnes ; dîner à l'hôtel pour 9 pax", personnes: 9 }),
    poste({
      nature: "ACCOMMODATION", libelle: "Hébergement — Hyatt Regency Alger", detail: "Une nuitée en chambre single, nuit du 05 au 06/11/2026", personnes: 2,
      hotel: "Hyatt Regency", ville: "Alger", dateArrivee: "2026-11-05", dateDepart: "2026-11-06", typeChambre: "Single",
      beneficiaires: [
        { prenom: "Nabil", nom: "Yafour", transport: "", trajets: [] },
        { prenom: "Malika", nom: "Allouda", transport: "", trajets: [] },
      ],
    }),
    poste({
      nature: "TICKETING", libelle: "Billetterie — Advisory Board", detail: "Vols intérieurs aller-retour pour 2 experts", personnes: 2,
      beneficiaires: [
        { prenom: "Nabil", nom: "Yafour", transport: "AVION", trajets: [trajet("Oran", "Alger", "2026-11-05", "matin"), trajet("Alger", "Oran", "2026-11-06", "matin")] },
        { prenom: "Habiba", nom: "Mehnaoui", transport: "AVION", trajets: [trajet("Annaba", "Alger", "2026-11-05", "matin"), trajet("Alger", "Annaba", "2026-11-05", "21h00")] },
      ],
      piecesAttendues: ["Pièces d'identité des voyageurs"],
    }),
  ],
  remarques: [],
};

const MODELE_UNE_PERSONNE = {
  evenement: ev({ nom: "Journée scientifique de cardiologie", type: "SCIENTIFIC_DAY", portee: "NATIONAL", format: "PRESENTIAL", dateDebut: "2026-12-12", dateFin: "2026-12-12", lieu: "Sheraton Club des Pins", ville: "Alger", pays: "Algérie", specialite: "Cardiologie" }),
  postes: [poste({
    nature: "TICKETING", libelle: "Billet — Dr Samir Bouzid", detail: "Aller simple Constantine → Alger, 11/12/2026, vol du soir", personnes: 1,
    beneficiaires: [{ prenom: "Samir", nom: "Bouzid", transport: "AVION", trajets: [trajet("Constantine", "Alger", "2026-12-11", "soir")] }],
  })],
  remarques: [],
};

const MODELE_EN_LETTRES = {
  evenement: ev({ nom: "Staff de pneumologie", type: "HOSPITAL_STAFF", portee: "NATIONAL", format: "PRESENTIAL", dateDebut: "2027-01-23", dateFin: "2027-01-23", lieu: "CHU Mustapha", ville: "Alger", pays: "Algérie", specialite: "Pneumologie" }),
  postes: [
    poste({
      nature: "ACCOMMODATION", libelle: "Hébergement — El Aurassi", detail: "Deux nuitées, chambre double", personnes: 1,
      hotel: "El Aurassi", ville: "Alger", dateArrivee: "2027-01-22", dateDepart: "2027-01-24", typeChambre: "Double",
      beneficiaires: [{ prenom: "Karim", nom: "Haddad", transport: "", trajets: [] }],
    }),
    poste({ nature: "DINNER", libelle: "Déjeuner du staff", detail: "23/01/2027 : déjeuner pour 15 personnes", personnes: 15 }),
  ],
  remarques: [],
};

const MODELE_SANS_BILLETTERIE = {
  evenement: ev({ nom: "Réunion d'experts — oncologie", type: "ROUND_TABLE", portee: "NATIONAL", format: "PRESENTIAL", dateDebut: "2026-12-03", dateFin: "2026-12-03", horaire: "9h00–13h00", lieu: "Hôtel Méridien", ville: "Oran", pays: "Algérie", specialite: "Oncologie", capacite: 20 }),
  postes: [
    poste({ nature: "VENUE", libelle: "Salle — Méridien Oran", detail: "03/12/2026, 9h00–13h00, 20 personnes, pause-café", personnes: 20 }),
    poste({ nature: "DINNER", libelle: "Déjeuner — Méridien Oran", detail: "03/12/2026 : déjeuner pour 20 convives", personnes: 20 }),
  ],
  remarques: [],
};

function modeleSimule(prompt: string): unknown {
  if (prompt.includes("Advisory Board")) return MODELE_ADVISORY;
  if (prompt.includes("Samir Bouzid")) return MODELE_UNE_PERSONNE;
  if (prompt.includes("vingt-trois janvier")) return MODELE_EN_LETTRES;
  if (prompt.includes("oncologie")) return MODELE_SANS_BILLETTERIE;
  return null;
}

const proposer = (description: string) => proposerPostesParModele({ description, natureDemande: "événement", userId: "u1", aujourdhui: AUJOURDHUI });

async function propositionDe(description: string) {
  const r = await proposer(description);
  if (!r.ok) throw new Error(`refus inattendu : ${r.raison} — ${r.error}`);
  return r.proposition;
}

const nature = (postes: readonly PostePropose[], n: string) => postes.find((p) => p.nature === n);

/** Le formulaire que l'écran enverrait à `addAdProItem`, relu par la règle des fiches du formulaire. */
async function relireCommeLeFormulaire(p: PostePropose) {
  const fd = new FormData();
  for (const [k, v] of versFormulairePoste(p, "EVENT", "evt1")) fd.append(k, v);
  return { fd, fiches: await lireFichesDuFormulaire(fd, p.nature) };
}

beforeEach(() => {
  APPELS.length = 0; JOURNAL.length = 0;
  COUPEE = false; ACTIVE = true; CONFIGUREE = true; PANNE = false;
  REPONSE = modeleSimule;
});

describe("Luna — les postes de l'Advisory Board (exemple réel de la Direction)", () => {
  it("passe par la passerelle, avec la description en DONNÉE et la date du jour", async () => {
    await propositionDe(ADVISORY);
    expect(APPELS).toHaveLength(1);
    expect(APPELS[0]!.prompt).toContain("2026-10-19 (lundi)");
    expect(APPELS[0]!.prompt).toContain("Hyatt Regency Alger");
    expect(APPELS[0]!.prompt).toMatch(/UNTRUSTED|non fiable|<<</i);
    expect(APPELS[0]!.system).toContain("Tu es Luna");
    expect(JOURNAL).toEqual([expect.objectContaining({ feature: "postes_luna", ok: true })]);
  });

  it("comprend l'événement : Advisory Board hématologie, Hyatt Regency Alger, 05/11/2026 13h–19h, 9 pax", async () => {
    const { evenement } = await propositionDe(ADVISORY);
    expect(evenement).toMatchObject({
      nom: "Advisory Board — hématologie", type: "ROUND_TABLE", dateDebut: "2026-11-05", dateFin: "2026-11-05",
      horaire: "13h00–19h00", lieu: "Hyatt Regency Alger", ville: "Alger", pays: "Algérie", specialite: "Hématologie", capacite: 9,
    });
  });

  it("propose quatre postes : salle (+ cocktail, pause-café), restauration, hébergement, billetterie", async () => {
    const { postes } = await propositionDe(ADVISORY);
    expect(postes.map((p) => p.nature)).toEqual(["VENUE", "DINNER", "ACCOMMODATION", "TICKETING"]);
    expect(nature(postes, "VENUE")!.notes).toMatch(/cocktail de bienvenue \+ pause-café pour 9 pax/);
    // La capacité de la salle n'est pas le nombre de convives : 2 au déjeuner, 9 au dîner.
    expect(nature(postes, "DINNER")!.notes).toMatch(/déjeuner pour 2 personnes ; dîner à l'hôtel pour 9 pax/);
  });

  it("l'hébergement : les deux personnes (nom ET prénom séparés), nuit du 5 au 6/11, single, Hyatt Regency", async () => {
    const h = nature((await propositionDe(ADVISORY)).postes, "ACCOMMODATION")!;
    expect(h.hebergements).toEqual([
      expect.objectContaining({ prenom: "Nabil", nom: "Yafour", hotel: "Hyatt Regency", ville: "Alger", dateArrivee: "2026-11-05", dateDepart: "2026-11-06", typeChambre: "Single" }),
      expect.objectContaining({ prenom: "Malika", nom: "Allouda", hotel: "Hyatt Regency", ville: "Alger", dateArrivee: "2026-11-05", dateDepart: "2026-11-06", typeChambre: "Single" }),
    ]);
  });

  it("la billetterie : un trajet par personne et par sens, créneaux matin / 21h00, en aller-retour", async () => {
    const b = nature((await propositionDe(ADVISORY)).postes, "TICKETING")!;
    const [nabil, habiba] = b.voyageurs;
    expect(nabil).toMatchObject({
      prenom: "Nabil", nom: "Yafour", trajet: "ALLER_RETOUR", transport: "AVION",
      villeDepart: "Oran", villeArrivee: "Alger", dateDepart: "2026-11-05", dateRetour: "2026-11-06",
    });
    expect(nabil!.resume).toBe("Oran → Alger 05/11 matin · Alger → Oran 06/11 matin");
    expect(nabil!.notes).toContain("Aller : matin · Retour : matin");
    // « Retour : le 5 novembre au soir, le vol de 21h00 » : le même jour, à 21h00.
    expect(habiba).toMatchObject({ prenom: "Habiba", nom: "Mehnaoui", trajet: "ALLER_RETOUR", villeDepart: "Annaba", villeArrivee: "Alger", dateDepart: "2026-11-05", dateRetour: "2026-11-05" });
    expect(habiba!.resume).toBe("Annaba → Alger 05/11 matin · Alger → Annaba 05/11 21h00");
  });

  it("« je joindrai les PI » : la pièce attendue est rattachée au poste billetterie et à chaque voyageur", async () => {
    const b = nature((await propositionDe(ADVISORY)).postes, "TICKETING")!;
    expect(b.piecesAttendues).toEqual(["Pièces d'identité des voyageurs"]);
    expect(b.notes).toContain("Pièce attendue : Pièces d'identité des voyageurs.");
    for (const v of b.voyageurs) expect(v.notes).toContain("À joindre : Pièces d'identité des voyageurs");
  });

  it("chaque poste passe la règle du formulaire d'ajout (les mêmes fiches que l'écran)", async () => {
    for (const p of (await propositionDe(ADVISORY)).postes) {
      const { fd, fiches } = await relireCommeLeFormulaire(p);
      expect(fiches.ok).toBe(true);
      expect(fd.get("parent")).toBe("EVENT");
      expect(fd.get("kind")).toBe(p.nature);
      if (fiches.ok) expect(fiches.fiches).toHaveLength(p.voyageurs.length + p.hebergements.length);
    }
    const b = nature((await propositionDe(ADVISORY)).postes, "TICKETING")!;
    const { fiches } = await relireCommeLeFormulaire(b);
    expect(fiches.ok && fiches.fiches[1]).toMatchObject({ nature: "VOYAGEUR", voyageur: { prenom: "Habiba", nom: "Mehnaoui", trajet: "ALLER_RETOUR", transport: "AVION" } });
  });
});

describe("Luna — les variantes", () => {
  it("une seule personne : un aller simple au soir, sans date de retour", async () => {
    const p = await propositionDe(UNE_PERSONNE);
    expect(p.evenement).toMatchObject({ type: "SCIENTIFIC_DAY", dateDebut: "2026-12-12", ville: "Alger", specialite: "Cardiologie" });
    expect(p.postes).toHaveLength(1);
    expect(p.postes[0]!.voyageurs).toEqual([expect.objectContaining({
      prenom: "Samir", nom: "Bouzid", trajet: "ALLER_SIMPLE", villeDepart: "Constantine", villeArrivee: "Alger", dateDepart: "2026-12-11", dateRetour: null,
    })]);
    expect(p.postes[0]!.voyageurs[0]!.resume).toBe("Constantine → Alger 11/12 soir");
    expect((await relireCommeLeFormulaire(p.postes[0]!)).fiches.ok).toBe(true);
  });

  it("dates en toutes lettres : deux nuitées du 22 au 24 janvier 2027, un déjeuner pour quinze", async () => {
    const p = await propositionDe(EN_LETTRES);
    expect(p.evenement).toMatchObject({ type: "HOSPITAL_STAFF", dateDebut: "2027-01-23", lieu: "CHU Mustapha", ville: "Alger" });
    const h = nature(p.postes, "ACCOMMODATION")!;
    expect(h.hebergements).toEqual([expect.objectContaining({ prenom: "Karim", nom: "Haddad", dateArrivee: "2027-01-22", dateDepart: "2027-01-24", typeChambre: "Double", hotel: "El Aurassi" })]);
    expect(nature(p.postes, "DINNER")!.personnes).toBe(15);
    expect(nature(p.postes, "TICKETING")).toBeUndefined();
  });

  it("sans billetterie : salle et déjeuner, aucune fiche voyageur ni hôtellerie", async () => {
    const p = await propositionDe(SANS_BILLETTERIE);
    expect(p.evenement).toMatchObject({ ville: "Oran", capacite: 20, horaire: "9h00–13h00" });
    expect(p.postes.map((x) => x.nature)).toEqual(["VENUE", "DINNER"]);
    expect(p.postes.every((x) => x.voyageurs.length === 0 && x.hebergements.length === 0)).toBe(true);
  });
});

describe("Luna — la relecture ne croit pas le modèle sur parole", () => {
  it("une personne absente de la description est écartée, et c'est dit", () => {
    const brut = { ...MODELE_ADVISORY, postes: [poste({ nature: "ACCOMMODATION", hotel: "Hyatt", beneficiaires: [{ prenom: "Nabil", nom: "Yafour", transport: "", trajets: [] }, { prenom: "Leila", nom: "Inventée", transport: "", trajets: [] }] })] };
    const p = lirePropositionModele(brut, ADVISORY)!;
    expect(p.postes[0]!.hebergements.map((h) => h.nom)).toEqual(["Yafour"]);
    expect(p.remarques.join(" ")).toContain("Leila Inventée");
  });

  it("une nature hors liste (sponsoring) n'est pas proposée ; une date inversée fait écarter le billet", () => {
    const brut = {
      ...MODELE_ADVISORY,
      postes: [
        poste({ nature: "ASSOCIATION_SUPPORT", libelle: "Sponsoring" }),
        poste({ nature: "TICKETING", beneficiaires: [{ prenom: "Nabil", nom: "Yafour", transport: "AVION", trajets: [trajet("Oran", "Alger", "2026-11-06"), trajet("Alger", "Oran", "2026-11-05")] }] }),
      ],
    };
    const p = lirePropositionModele(brut, ADVISORY)!;
    expect(p.postes.map((x) => x.nature)).toEqual(["TICKETING"]);
    expect(p.postes[0]!.voyageurs).toHaveLength(0);
    expect(p.remarques.join(" ")).toMatch(/ASSOCIATION_SUPPORT/);
    expect(p.remarques.join(" ")).toMatch(/Billet de Nabil Yafour : .*retour précède/);
  });

  it("une réponse hors contrat ne donne rien (et ne casse rien)", () => {
    expect(lirePropositionModele(null, ADVISORY)).toBeNull();
    expect(lirePropositionModele({ postes: "x" }, ADVISORY)).toBeNull();
  });
});

describe("Luna — l'abstention propre : la demande se crée normalement sans proposition", () => {
  it("sans clé d'IA : aucun appel, raison NON_CONFIGUREE", async () => {
    CONFIGUREE = false;
    const r = await proposer(ADVISORY);
    expect(r).toMatchObject({ ok: false, raison: "NON_CONFIGUREE" });
    expect(APPELS).toHaveLength(0);
  });

  it("interrupteur coupé, assistant désactivé, description trop courte : aucun appel", async () => {
    COUPEE = true;
    expect(await proposer(ADVISORY)).toMatchObject({ ok: false, raison: "IA_COUPEE" });
    COUPEE = false; ACTIVE = false;
    expect(await proposer(ADVISORY)).toMatchObject({ ok: false, raison: "DESACTIVEE" });
    ACTIVE = true;
    expect(await proposer("Salle pour 9.")).toMatchObject({ ok: false, raison: "TROP_COURT" });
    expect(APPELS).toHaveLength(0);
  });

  it("une panne du fournisseur se dit en une phrase, et se journalise en échec", async () => {
    PANNE = true;
    expect(await proposer(ADVISORY)).toMatchObject({ ok: false, raison: "ECHEC" });
    expect(JOURNAL).toEqual([expect.objectContaining({ feature: "postes_luna", ok: false, errorCode: "exception" })]);
  });

  it("le repère du jour se lit en clair", () => {
    expect(aujourdhuiLisible(AUJOURDHUI)).toBe("2026-10-19 (lundi)");
  });
});
