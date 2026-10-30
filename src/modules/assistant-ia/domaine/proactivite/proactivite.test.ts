import { describe, expect, it } from "vitest";
import {
  ajusterFacteur, estCalme, estDiscret, estMomentDuMatin, normaliserPreferences, PREFERENCES_PAR_DEFAUT, repartir, tauxUtile,
  type Candidat,
} from "./budget";
import {
  budgetsAuSeuil, demandesBloquees, doublonsDeFactures, echeancesReglementaires, FICHE_VEILLEUR, reunionsProches, seuilEffectif,
  validationsEnAttente, VEILLEURS,
} from "./veilleurs";
import { CAPACITE, consoleRequise, mandatable, niveauDe, validerDemandeMandat, verifierGeste } from "./mandats";

/** Alger = UTC+1 : « mardi 3 novembre 2026 à 10 h, Alger » = 09:00Z. Le 3/11/2026 est un mardi. */
const alger = (jour: string, heure: number) => new Date(`${jour}T${String(heure - 1).padStart(2, "0")}:00:00.000Z`);
const MARDI_10H = alger("2026-11-03", 10);
const J = 86_400_000;

describe("veilleurs — des règles, une signature", () => {
  it("chaque veilleur a une fiche cohérente (seuil dans ses bornes, famille, pôle)", () => {
    expect(new Set(VEILLEURS.map((v) => v.code)).size).toBe(VEILLEURS.length);
    for (const v of VEILLEURS) expect(v.seuil.valeur).toBeGreaterThanOrEqual(v.seuil.min), expect(v.seuil.valeur).toBeLessThanOrEqual(v.seuil.max);
  });

  it("une demande bloquée est dite une fois : sa clé ne bouge pas d'un jour à l'autre, elle change si la demande repart", () => {
    const l = { id: "s1", reference: "SPO-1", nature: "SPONSORING" as const, titre: "CHU Oran", statut: "AWAITING_FINAL", majLe: new Date(MARDI_10H.getTime() - 8 * J), lien: "/sponsoring/s1" };
    const a = demandesBloquees([l], 7, MARDI_10H);
    const b = demandesBloquees([l], 7, new Date(MARDI_10H.getTime() + J));
    expect(a).toHaveLength(1);
    expect(a[0]!.titre).toContain("8 jours");
    expect(b[0]!.cle).toBe(a[0]!.cle);
    expect(demandesBloquees([{ ...l, majLe: new Date(MARDI_10H.getTime() - 6 * J) }], 7, MARDI_10H)).toHaveLength(0);
    expect(demandesBloquees([{ ...l, majLe: new Date(MARDI_10H.getTime() - 9 * J) }], 7, MARDI_10H)[0]!.cle).not.toBe(a[0]!.cle);
  });

  it("budget : 90 % puis 100 % sont deux constats ; 89 % rien", () => {
    const base = { id: "b1", nom: "Congrès", initial: 1_000_000, consomme: 850_000, engage: 50_000 };
    expect(budgetsAuSeuil([{ ...base, engage: 30_000 }], 90)).toHaveLength(0);
    const a = budgetsAuSeuil([base], 90);
    const b = budgetsAuSeuil([{ ...base, consomme: 1_000_000 }], 90);
    expect(a[0]!.titre).toContain("90 %");
    expect(b[0]!.gravite).toBe("URGENT");
    expect(a[0]!.cle).not.toBe(b[0]!.cle);
  });

  it("échéance ANPP : « proche » puis « dépassée », deux paliers dits chacun une fois", () => {
    const l = { id: "o1", source: "OBLIGATION" as const, titre: "Réponse ANPP (DOS-7)", echeance: new Date(MARDI_10H.getTime() + 5 * J), lien: "/x" };
    const proche = echeancesReglementaires([l], 14, MARDI_10H)[0]!;
    const passee = echeancesReglementaires([l], 14, new Date(MARDI_10H.getTime() + 6 * J))[0]!;
    expect(proche.titre).toContain("dans 5 jours");
    expect(passee.titre).toContain("dépassée");
    expect(passee.gravite).toBe("URGENT");
    expect(proche.cle).not.toBe(passee.cle);
    expect(echeancesReglementaires([{ ...l, echeance: new Date(MARDI_10H.getTime() + 20 * J) }], 14, MARDI_10H)).toHaveLength(0);
  });

  it("doublons de factures : même fournisseur et même numéro (à la casse près) ; une paire dite une fois", () => {
    const f = (id: string, reference: string | null, fournisseur: string, montant: number, jour: string) => ({ id, reference, fournisseur, montant, date: new Date(jour) });
    const c = doublonsDeFactures([
      f("a", "FA-0012", "Pharmalliance SPA", 120_000, "2026-10-01"),
      f("b", "fa 12", "PHARMALLIANCE spa", 99_000, "2026-10-09"),
      f("c", "X-9", "Autre", 50_000, "2026-10-02"),
      f("d", "X-10", "Autre", 50_000, "2026-10-02"),
      f("e", "Z-1", "Tiers", 10, "2026-10-02"),
    ]);
    expect(c).toHaveLength(2);
    expect(c.find((x) => x.cle === "a+b")?.gravite).toBe("URGENT");
    expect(c.find((x) => x.cle === "c+d")?.detail).toContain("même jour");
  });

  it("validation qui traîne : clé = demande + étape (une seule relance par étape)", () => {
    const c = validationsEnAttente([{ id: "v1", reference: "VAL-3", titre: "Achat", validateur: "Karim", etapeId: "e2", depuis: new Date(MARDI_10H.getTime() - 6 * J) }], 5, MARDI_10H);
    expect(c[0]!.cle).toBe("v1:e2");
    expect(c[0]!.titre).toContain("Karim");
  });

  it("une heure avant une réunion : dans la fenêtre seulement, avec les points ouverts sur les participants", () => {
    const r = { id: "m1", source: "REUNION" as const, titre: "Revue Ad & Pro", participants: ["Karim B."], lien: "/meetings/m1" };
    expect(reunionsProches([{ ...r, debut: new Date(MARDI_10H.getTime() + 60 * 60_000) }], 60, MARDI_10H, () => 2)[0]!.detail).toContain("2 points ouverts");
    expect(reunionsProches([{ ...r, debut: new Date(MARDI_10H.getTime() + 3 * 3_600_000) }], 60, MARDI_10H)).toHaveLength(0);
  });

  it("le seuil effectif monte avec le facteur appris, borné par la fiche", () => {
    const f = FICHE_VEILLEUR.get("ADPRO_DEMANDE_BLOQUEE")!;
    expect(seuilEffectif(f, null, 1)).toBe(7);
    expect(seuilEffectif(f, 10, 1.5)).toBe(15);
    expect(seuilEffectif(f, 50, 3)).toBe(60);
    expect(seuilEffectif(FICHE_VEILLEUR.get("BUDGET_SEUIL")!, 90, 2)).toBe(95);
  });
});

describe("budget d'interruptions", () => {
  const c = (id: string, gravite: Candidat["gravite"] = "ATTENTION", discret = false): Candidat => ({ id, veilleur: "BC_NON_SIGNE", gravite, discret });

  it("heures calmes (19 h → 8 h, Alger) et week-end vendredi-samedi", () => {
    expect(estCalme(MARDI_10H, PREFERENCES_PAR_DEFAUT)).toBe(false);
    expect(estCalme(alger("2026-11-03", 20), PREFERENCES_PAR_DEFAUT)).toBe(true);
    expect(estCalme(alger("2026-11-03", 7), PREFERENCES_PAR_DEFAUT)).toBe(true);
    expect(estCalme(alger("2026-11-06", 11), PREFERENCES_PAR_DEFAUT)).toBe(true); // vendredi
    expect(estCalme(alger("2026-11-08", 11), PREFERENCES_PAR_DEFAUT)).toBe(false); // dimanche, jour ouvré
    expect(estCalme(alger("2026-11-06", 11), { ...PREFERENCES_PAR_DEFAUT, weekendCalme: false })).toBe(false);
  });

  it("trois constats → UNE interruption regroupée, le plus grave d'abord", () => {
    const r = repartir([c("a", "INFO"), c("b", "URGENT"), c("c")], PREFERENCES_PAR_DEFAUT, { faites: 0, derniere: null }, MARDI_10H);
    expect(r.interruption).toEqual(["b", "c", "a"]);
    expect(r.raison).toContain("regroupés");
  });

  it("heures calmes : tout attend ; moins d'une heure après la précédente : tout attend", () => {
    expect(repartir([c("a")], PREFERENCES_PAR_DEFAUT, { faites: 0, derniere: null }, alger("2026-11-03", 22)).attente).toEqual(["a"]);
    expect(repartir([c("a")], PREFERENCES_PAR_DEFAUT, { faites: 1, derniere: new Date(MARDI_10H.getTime() - 20 * 60_000) }, MARDI_10H).attente).toEqual(["a"]);
  });

  it("plafond du jour : au journal, sans notification ; un veilleur discret va toujours au journal", () => {
    const r = repartir([c("a"), c("d", "INFO", true)], PREFERENCES_PAR_DEFAUT, { faites: 5, derniere: null }, MARDI_10H);
    expect(r.interruption).toEqual([]);
    expect(r.journal.sort()).toEqual(["a", "d"]);
    expect(repartir([c("d", "URGENT", true)], PREFERENCES_PAR_DEFAUT, { faites: 0, derniere: null }, MARDI_10H).journal).toEqual(["d"]);
  });

  it("≤ 5 par jour : sur une journée de constats toutes les 15 min, au plus 5 interruptions", () => {
    let faites = 0;
    let derniere: Date | null = null;
    for (let m = 0; m < 24 * 60; m += 15) {
      const now = new Date(alger("2026-11-03", 1).getTime() + m * 60_000);
      const r = repartir([c(`x${m}`)], PREFERENCES_PAR_DEFAUT, { faites, derniere }, now);
      if (r.interruption.length) { faites++; derniere = now; }
    }
    expect(faites).toBe(5);
  });

  it("la personne baisse son plafond, jamais au-dessus de celui de la console", () => {
    expect(normaliserPreferences({ interruptionsMax: 12 }, 5).interruptionsMax).toBe(5);
    expect(normaliserPreferences({ interruptionsMax: 2 }, 5).interruptionsMax).toBe(2);
    expect(normaliserPreferences({ calmeDebut: 40 }).calmeDebut).toBe(23);
  });

  it("le point du matin : premier passage d'un jour ouvré, après les heures calmes, une fois", () => {
    expect(estMomentDuMatin(alger("2026-11-03", 8), PREFERENCES_PAR_DEFAUT, null)).toBe(true);
    expect(estMomentDuMatin(alger("2026-11-03", 9), PREFERENCES_PAR_DEFAUT, alger("2026-11-03", 8))).toBe(false);
    expect(estMomentDuMatin(alger("2026-11-03", 12), PREFERENCES_PAR_DEFAUT, null)).toBe(false);
    expect(estMomentDuMatin(alger("2026-11-06", 8), PREFERENCES_PAR_DEFAUT, null)).toBe(false);
  });

  it("les retours ajustent : pas utile → seuil plus long ; trop peu utile → discret ; mesure du taux", () => {
    expect(ajusterFacteur(1, "PAS_UTILE")).toBe(1.25);
    expect(ajusterFacteur(1.25, "UTILE")).toBe(1.14);
    expect(ajusterFacteur(1, "UTILE")).toBe(1);
    expect(ajusterFacteur(2.9, "PAS_UTILE")).toBe(3);
    expect(estDiscret({ utiles: 0, inutiles: 3 })).toBe(true);
    expect(estDiscret({ utiles: 1, inutiles: 1 })).toBe(false);
    expect(tauxUtile({ utiles: 3, inutiles: 2 })).toBe(0.6);
  });
});

describe("mandats — bornés, révocables, R1 par défaut", () => {
  const now = MARDI_10H;

  it("la relance est R1 et se mandate sans la console ; une opération inconnue vaut R4", () => {
    const c = CAPACITE.get("RELANCER_VALIDATEUR")!;
    expect(niveauDe(c.operation)).toBe("R1");
    expect(consoleRequise(c)).toBe(false);
    expect(niveauDe("supprimer_tout")).toBe("R4");
    expect(mandatable({ operation: "preparer_bon_de_commande" })).toBe(false);
    expect(consoleRequise({ famille: "CONTRATS_RH", operation: "preparer_relance" })).toBe(true);
    expect(consoleRequise({ famille: "ECRITURES", operation: "preparer_rendez_vous" })).toBe(true);
  });

  it("une demande de mandat a une échéance (1 à 90 jours) et un plafond par jour", () => {
    expect(validerDemandeMandat({ capacite: "RELANCER_VALIDATEUR", jours: 0 }, now).ok).toBe(false);
    expect(validerDemandeMandat({ capacite: "RELANCER_VALIDATEUR", jours: 91 }, now).ok).toBe(false);
    expect(validerDemandeMandat({ capacite: "RELANCER_VALIDATEUR", jours: 30, gestesParJour: 11 }, now).ok).toBe(false);
    expect(validerDemandeMandat({ capacite: "PAYER", jours: 30 }, now).ok).toBe(false);
    const v = validerDemandeMandat({ capacite: "RELANCER_VALIDATEUR", jours: 30, destinataires: ["u1", "u1", 3] }, now);
    expect(v.ok && v.demande.destinataires).toEqual(["u1"]);
    expect(v.ok && v.demande.expireLe.getTime()).toBe(now.getTime() + 30 * J);
  });

  it("chaque geste est relu contre ses bornes : statut, échéance, capacité, plafond du jour, destinataires, montant", () => {
    const m = { statut: "ACTIF", capacite: "RELANCER_VALIDATEUR", destinataires: ["karim"], montantMax: null, gestesParJour: 2, expireLe: new Date(now.getTime() + J) };
    const g = { capacite: "RELANCER_VALIDATEUR", destinataires: ["karim"], montant: null };
    expect(verifierGeste(m, g, 0, now)).toEqual({ ok: true });
    expect(verifierGeste({ ...m, statut: "REVOQUE" }, g, 0, now).ok).toBe(false);
    expect(verifierGeste({ ...m, statut: "EN_ATTENTE_CONSOLE" }, g, 0, now)).toEqual({ ok: false, raison: "mandat en attente de l'accord de la console" });
    expect(verifierGeste(m, g, 0, new Date(now.getTime() + 2 * J)).ok).toBe(false);
    expect(verifierGeste(m, g, 2, now)).toEqual({ ok: false, raison: "plafond de 2 geste(s) par jour atteint" });
    expect(verifierGeste(m, { ...g, destinataires: ["nadia"] }, 0, now)).toEqual({ ok: false, raison: "destinataire hors du mandat" });
    expect(verifierGeste(m, { ...g, montant: 10 }, 0, now).ok).toBe(false);
    expect(verifierGeste({ ...m, destinataires: [] }, { ...g, destinataires: ["nadia"] }, 0, now).ok).toBe(true);
  });
});
