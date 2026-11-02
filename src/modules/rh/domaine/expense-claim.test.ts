import { describe, it, expect } from "vitest";
import {
  canEditExpenseClaim, expenseEditDeadline, expenseEditLabel, expenseAmountError,
  EXPENSE_EDIT_MINUTES, EXPENSE_AMOUNT_MAX,
} from "./expense-claim";

const T0 = new Date("2026-09-04T10:00:00Z");
const plus = (min: number) => new Date(T0.getTime() + min * 60_000);

const etat = (o: Partial<Parameters<typeof canEditExpenseClaim>[0]> = {}) => ({
  editableUntil: expenseEditDeadline(T0),
  editUnlockedAt: null,
  status: "PENDING",
  ...o,
});

describe("les quinze minutes pour se corriger", () => {
  it("juste après l'envoi, on modifie", () => {
    const v = canEditExpenseClaim(etat(), plus(1));
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe("WINDOW");
  });

  it("LE COMPTE À REBOURS S'ARRONDIT AU SUPÉRIEUR — « 0 min » ferait renoncer à tort", () => {
    // Il reste quarante secondes : la correction est encore possible, et l'écran doit le dire.
    const v = canEditExpenseClaim(etat(), new Date(plus(EXPENSE_EDIT_MINUTES).getTime() - 40_000));
    expect(v.allowed).toBe(true);
    expect(v.minutesLeft).toBe(1);
    expect(expenseEditLabel(v)).toMatch(/une minute/);
  });

  it("à la seizième minute, c'est fermé — ET ON DIT QUOI FAIRE", () => {
    const v = canEditExpenseClaim(etat(), plus(16));
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("EXPIRED");
    // Un bouton grisé sans explication se lit comme une panne, et la personne dépose une
    // SECONDE note — exactement ce que toute cette mécanique existe pour éviter.
    expect(expenseEditLabel(v)).toMatch(/demandez aux rh/i);
    expect(expenseEditLabel(v)).toMatch(/seconde note/i);
  });

  it("pile à l'échéance, c'est fermé : la borne n'est pas ouverte des deux côtés", () => {
    expect(canEditExpenseClaim(etat(), plus(EXPENSE_EDIT_MINUTES)).allowed).toBe(false);
  });
});

describe("la réouverture par les RH", () => {
  it("ELLE PRIME SUR L'HORLOGE — sinon la décision humaine serait contredite par une minuterie", () => {
    const v = canEditExpenseClaim(etat({ editUnlockedAt: plus(60) }), plus(120));
    expect(v.allowed).toBe(true);
    expect(v.reason).toBe("UNLOCKED");
    expect(expenseEditLabel(v)).toMatch(/rouvert/i);
  });

  it("…mais elle ne ressuscite pas une note TRANCHÉE", () => {
    // Modifier après coup changerait ce sur quoi quelqu'un s'est prononcé : l'audit dirait
    // « validée » à côté d'un montant que le validateur n'a jamais vu.
    for (const status of ["READY", "DELIVERED", "APPROVED", "REJECTED"]) {
      const v = canEditExpenseClaim(etat({ status, editUnlockedAt: plus(60) }), plus(61));
      expect(v.allowed, status).toBe(false);
      expect(v.reason).toBe("DECIDED");
    }
    expect(expenseEditLabel(canEditExpenseClaim(etat({ status: "REJECTED" }), plus(1))))
      .toMatch(/se refait/i);
  });

  it("une note EN COURS D'INSTRUCTION reste corrigeable si les RH l'ont rouverte", () => {
    expect(canEditExpenseClaim(etat({ status: "IN_PROGRESS", editUnlockedAt: plus(30) }), plus(90)).allowed).toBe(true);
  });
});

describe("les notes déposées avant cette règle", () => {
  it("SANS FENÊTRE ENREGISTRÉE, ELLES NE S'OUVRENT PAS TOUTES SEULES", () => {
    // La migration ne remplit pas `editableUntil` rétroactivement : quinze minutes accordées à
    // une note vieille de trois semaines seraient déjà écoulées, et une réouverture massive
    // serait une décision que personne n'a prise. Les RH peuvent toujours rouvrir au cas par cas.
    const v = canEditExpenseClaim({ editableUntil: null, editUnlockedAt: null, status: "PENDING" }, T0);
    expect(v.allowed).toBe(false);
    expect(v.reason).toBe("EXPIRED");
  });
});

describe("le montant", () => {
  it("ZÉRO N'EST PAS UN MONTANT — c'est un champ qu'on a sauté", () => {
    expect(expenseAmountError(0)).toMatch(/supérieur à zéro/);
    expect(expenseAmountError(-100)).toMatch(/supérieur à zéro/);
  });

  it("absent, on le dit clairement", () => {
    expect(expenseAmountError(null)).toMatch(/montant que vous avez avancé/);
  });

  it("UNE FAUTE DE FRAPPE SE REMBOURSE UNE FOIS ET NE SE RÉCUPÈRE JAMAIS", () => {
    // 4 200 tapé 4200000.
    expect(expenseAmountError(EXPENSE_AMOUNT_MAX + 1)).toMatch(/paraît erroné/);
    expect(expenseAmountError(EXPENSE_AMOUNT_MAX)).toBeNull();
  });

  it("un montant ordinaire passe", () => {
    expect(expenseAmountError(4200)).toBeNull();
    expect(expenseAmountError(0.5)).toBeNull();
  });
});
