import { describe, it, expect } from "vitest";
import {
  daysBetween, expiryLevel, daysLeft, effectiveStatus, shouldRemind, expiryMessage,
  canRenew, canCancel, proposeRenewalDates, validateDates,
  REMIND_SOON_DAYS, REMIND_IMMINENT_DAYS,
  DUREE_PONCTUELLE_MAX_JOURS, estPonctuel, estTermine, statutLegalAffiche,
} from "./lifecycle";

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
const TODAY = D("2026-06-01");
const active = (endDate: Date | null) => ({ status: "ACTIVE" as const, endDate });

describe("Compter les jours", () => {
  it("compte des jours entiers, dans les deux sens", () => {
    expect(daysBetween(D("2026-06-01"), D("2026-06-30"))).toBe(29);
    expect(daysBetween(D("2026-06-01"), D("2026-06-01"))).toBe(0);
    expect(daysBetween(D("2026-06-01"), D("2026-05-31"))).toBe(-1);
  });
});

describe("Un document SANS date de fin ne se périme jamais", () => {
  it("ne produit ni niveau d'échéance ni rappel", () => {
    const doc = { ...active(null), lastRemindedAt: null };
    expect(expiryLevel(doc, TODAY)).toBe("NONE");
    expect(daysLeft(doc, TODAY)).toBeNull();
    expect(shouldRemind(doc, TODAY)).toBe(false);
    expect(effectiveStatus(doc, TODAY)).toBe("ACTIVE");
  });
});

describe("L'urgence est GRADUÉE — un seuil unique ne sait dire que « bientôt »", () => {
  it("classe l'échéance selon ce qui reste", () => {
    expect(expiryLevel(active(D("2027-01-01")), TODAY)).toBe("SCHEDULED");
    expect(expiryLevel(active(D("2026-08-15")), TODAY)).toBe("SOON");      // ~75 j
    expect(expiryLevel(active(D("2026-06-20")), TODAY)).toBe("IMMINENT");  // 19 j
    expect(expiryLevel(active(D("2026-06-01")), TODAY)).toBe("IMMINENT");  // aujourd'hui
    expect(expiryLevel(active(D("2026-05-31")), TODAY)).toBe("OVERDUE");
  });

  it("les bornes exactes tombent du bon côté", () => {
    const soon = new Date(TODAY.getTime() + REMIND_SOON_DAYS * 86_400_000);
    const imminent = new Date(TODAY.getTime() + REMIND_IMMINENT_DAYS * 86_400_000);
    expect(expiryLevel(active(soon), TODAY)).toBe("SOON");
    expect(expiryLevel(active(imminent), TODAY)).toBe("IMMINENT");
  });
});

describe("Un document sorti du jeu ne rappelle plus", () => {
  it("annulé ou renouvelé : silence, même avec une échéance dépassée", () => {
    const past = D("2026-01-01");
    expect(expiryLevel({ status: "CANCELLED", endDate: past }, TODAY)).toBe("NONE");
    expect(expiryLevel({ status: "RENEWED", endDate: past }, TODAY)).toBe("NONE");
    expect(shouldRemind({ status: "CANCELLED", endDate: past, lastRemindedAt: null }, TODAY)).toBe(false);
  });

  it("garde son statut : la suite vit ailleurs, on ne la réécrit pas en « expiré »", () => {
    expect(effectiveStatus({ status: "RENEWED", endDate: D("2026-01-01") }, TODAY)).toBe("RENEWED");
    expect(effectiveStatus({ status: "CANCELLED", endDate: D("2026-01-01") }, TODAY)).toBe("CANCELLED");
  });
});

describe("Le statut effectif tient compte du calendrier", () => {
  it("un terme passé rend le document expiré, sans qu'on ait rouvert la fiche", () => {
    expect(effectiveStatus(active(D("2026-05-31")), TODAY)).toBe("EXPIRED");
    expect(effectiveStatus(active(D("2026-06-30")), TODAY)).toBe("ACTIVE");
  });
});

describe("On rappelle au CHANGEMENT de niveau, pas tous les jours", () => {
  it("premier rappel dès l'entrée en zone", () => {
    expect(shouldRemind({ ...active(D("2026-06-20")), lastRemindedAt: null }, TODAY)).toBe(true);
  });

  it("ne redit rien tant qu'on est au même niveau", () => {
    // Rappelé il y a 5 jours, déjà en IMMINENT → on se tait.
    expect(shouldRemind({ ...active(D("2026-06-20")), lastRemindedAt: D("2026-05-27") }, TODAY)).toBe(false);
  });

  it("reparle quand on passe de « soon » à « imminent »", () => {
    // Le 2026-04-01 il restait 80 j (SOON) ; aujourd'hui 19 j (IMMINENT) → on reparle.
    expect(shouldRemind({ ...active(D("2026-06-20")), lastRemindedAt: D("2026-04-01") }, TODAY)).toBe(true);
  });

  it("une échéance lointaine ne réveille personne", () => {
    expect(shouldRemind({ ...active(D("2027-06-01")), lastRemindedAt: null }, TODAY)).toBe(false);
  });
});

describe("Renouveler et annuler", () => {
  it("ne s'appliquent qu'à ce qui est encore en jeu", () => {
    expect(canRenew("ACTIVE")).toBe(true);
    expect(canRenew("EXPIRED")).toBe(true);   // renouveler en retard reste le geste normal
    expect(canRenew("RENEWED")).toBe(false);  // la suite existe déjà
    expect(canCancel("CANCELLED")).toBe(false);
  });

  it("propose la reconduction : lendemain du terme, même durée", () => {
    const r = proposeRenewalDates({ startDate: D("2025-01-01"), endDate: D("2025-12-31") });
    expect(r.startDate?.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(r.endDate?.toISOString().slice(0, 10)).toBe("2026-12-31");
  });

  it("sans terme précédent, ne devine aucune date", () => {
    expect(proposeRenewalDates({ startDate: D("2025-01-01"), endDate: null }))
      .toEqual({ startDate: null, endDate: null });
  });

  it("sans date de début, propose le départ mais pas la fin", () => {
    const r = proposeRenewalDates({ startDate: null, endDate: D("2025-12-31") });
    expect(r.startDate?.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(r.endDate).toBeNull();
  });
});

describe("Contrôle des dates", () => {
  it("refuse un terme antérieur au début", () => {
    expect(validateDates(D("2026-06-01"), D("2026-01-01")).ok).toBe(false);
  });
  it("accepte l'absence de date — c'est un cas normal, pas un oubli", () => {
    expect(validateDates(null, null)).toEqual({ ok: true });
    expect(validateDates(D("2026-01-01"), null)).toEqual({ ok: true });
    expect(validateDates(null, D("2026-01-01"))).toEqual({ ok: true });
  });
});

describe("expiryMessage — ce que dit le rappel, seul sur un écran verrouillé", () => {
  it("ne dit RIEN quand il n'y a rien à dire", () => {
    // Ni pour un document sans échéance, ni pour un terme encore lointain : une notification
    // qu'on n'attendait pas apprend à ignorer les suivantes.
    expect(expiryMessage("NONE", null, "Statuts")).toBeNull();
    expect(expiryMessage("SCHEDULED", 200, "Bail")).toBeNull();
  });

  it("porte TOUJOURS le nombre de jours — « échéance proche » ne fait lever personne", () => {
    expect(expiryMessage("SOON", 62, "Assurance flotte")?.title).toContain("62 jours");
    expect(expiryMessage("IMMINENT", 12, "Assurance flotte")?.title).toContain("12 jours");
  });

  it("dit « aujourd'hui » et « demain » plutôt que « dans 0 jour »", () => {
    expect(expiryMessage("IMMINENT", 0, "Bail")?.title).toContain("aujourd'hui");
    expect(expiryMessage("IMMINENT", 1, "Bail")?.title).toContain("demain");
  });

  it("nomme le dépassement pour ce qu'il est, avec son ancienneté", () => {
    const m = expiryMessage("OVERDUE", -9, "Contrat de maintenance");
    expect(m?.title).toContain("DÉPASSÉE");
    expect(m?.title).toContain("9 jours");
    expect(m?.body).toContain("Contrat de maintenance");
  });

  it("un titre vide ne produit pas un message amputé", () => {
    expect(expiryMessage("IMMINENT", 5, "   ")?.body).toContain("Document sans titre");
  });
});

describe("UN ENGAGEMENT PONCTUEL SE TERMINE, IL N'ÉCHOIT PAS (Super Admin, 25/11/2026)", () => {
  // Le cas réel : « Convention Orateur », contrat, début = fin = 14/09/2026, affiché « Échu » en rouge et remonté en alerte.
  const convention = { status: "ACTIVE" as const, startDate: D("2026-09-14"), endDate: D("2026-09-14"), lastRemindedAt: null };
  const LE_25_11 = D("2026-11-25");

  it("ponctuel : début et fin connus, au plus 31 jours d'écart ; sans début, on ne sait pas — durable", () => {
    expect(DUREE_PONCTUELLE_MAX_JOURS).toBe(31);
    expect(estPonctuel(convention)).toBe(true);
    expect(estPonctuel({ startDate: D("2026-09-01"), endDate: D("2026-10-02") })).toBe(true); // 31 jours
    expect(estPonctuel({ startDate: D("2026-09-01"), endDate: D("2026-10-03") })).toBe(false); // 32 jours
    expect(estPonctuel({ startDate: null, endDate: D("2026-09-14") })).toBe(false);
    expect(estPonctuel({ endDate: D("2026-09-14") })).toBe(false);
    expect(estPonctuel({ startDate: D("2026-09-14"), endDate: null })).toBe(false);
  });

  it("sa fin passée : « Terminé » à l'écran, EXPIRED en base, AUCUN niveau d'échéance, aucun rappel", () => {
    expect(estTermine(convention, LE_25_11)).toBe(true);
    expect(statutLegalAffiche(convention, LE_25_11)).toBe("TERMINE");
    expect(effectiveStatus(convention, LE_25_11)).toBe("EXPIRED");
    expect(expiryLevel(convention, LE_25_11)).toBe("NONE");
    expect(shouldRemind(convention, LE_25_11)).toBe(false);
    // Déjà en base EXPIRED (aligné hier, avant la règle) : toujours « Terminé », toujours muet.
    expect(statutLegalAffiche({ ...convention, status: "EXPIRED" }, LE_25_11)).toBe("TERMINE");
    expect(shouldRemind({ ...convention, status: "EXPIRED" }, LE_25_11)).toBe(false);
  });

  it("le jour même et avant, il n'est pas terminé : il garde son échéance comme les autres", () => {
    expect(estTermine(convention, D("2026-09-14"))).toBe(false);
    expect(expiryLevel(convention, D("2026-09-14"))).toBe("IMMINENT");
    expect(statutLegalAffiche(convention, D("2026-09-10"))).toBe("ACTIVE");
  });

  it("annulé ou renouvelé : ni « Terminé », ni échu — son statut", () => {
    expect(statutLegalAffiche({ ...convention, status: "CANCELLED" }, LE_25_11)).toBe("CANCELLED");
    expect(statutLegalAffiche({ ...convention, status: "RENEWED" }, LE_25_11)).toBe("RENEWED");
  });

  it("un engagement DURABLE garde l'alerte : dépassé, il est « Échu » et rappelé", () => {
    const bail = { status: "ACTIVE" as const, startDate: D("2025-11-01"), endDate: D("2026-11-01"), lastRemindedAt: null };
    expect(estTermine(bail, LE_25_11)).toBe(false);
    expect(expiryLevel(bail, LE_25_11)).toBe("OVERDUE");
    expect(statutLegalAffiche(bail, LE_25_11)).toBe("EXPIRED");
    expect(shouldRemind(bail, LE_25_11)).toBe(true);
    // Sans date de début (durée inconnue) : durable, l'alerte reste.
    expect(expiryLevel({ status: "ACTIVE", endDate: D("2026-09-14") }, LE_25_11)).toBe("OVERDUE");
  });
});
