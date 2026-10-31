import { describe, expect, it } from "vitest";
import {
  attentePourCanal, attenteRattachable, canauxAttendus, categorieProposee, cleTelephone, dureeAttenteHeures, masquerExpediteur,
  messageDeReception, pieceConfidentielle, sectionAttentes, type AttenteVue,
} from "./attentes";

const T0 = new Date("2026-10-31T10:00:00Z");
const attente = (o: Partial<AttenteVue & { createdAt: Date }> = {}): AttenteVue & { createdAt: Date } => ({
  id: "a1", description: "lettre de demande du Dr Mansouri", canaux: ["WHATSAPP"], cibleLibelle: "SP-2026-014 — CHU Mustapha",
  etat: "OUVERTE", expireLe: new Date(T0.getTime() + 48 * 3_600_000), recueLe: null, createdAt: T0, ...o,
});

describe("K6 — l'attente de pièces (règles pures)", () => {
  it("48 h par défaut, réglable, bornée", () => {
    expect(dureeAttenteHeures(undefined)).toBe(48);
    expect(dureeAttenteHeures("72")).toBe(72);
    expect(dureeAttenteHeures("0")).toBe(48);
    expect(dureeAttenteHeures("10000")).toBe(48);
  });

  it("les canaux dits en clair", () => {
    expect(canauxAttendus("par WhatsApp")).toEqual(["WHATSAPP"]);
    expect(canauxAttendus("mail ou whatsapp")).toEqual(["WHATSAPP", "MAIL"]);
    expect(canauxAttendus("")).toEqual([]);
  });

  it("rattachable : ouverte et non expirée ; reçue, encore 30 min ; expirée, jamais", () => {
    expect(attenteRattachable(attente(), T0)).toBe(true);
    expect(attenteRattachable(attente({ expireLe: T0 }), T0)).toBe(false);
    expect(attenteRattachable(attente({ etat: "RECUE", recueLe: new Date(T0.getTime() - 10 * 60_000) }), T0)).toBe(true);
    expect(attenteRattachable(attente({ etat: "RECUE", recueLe: new Date(T0.getTime() - 40 * 60_000) }), T0)).toBe(false);
    expect(attenteRattachable(attente({ etat: "ANNULEE" }), T0)).toBe(false);
  });

  it("le canal choisit l'attente : la plus récente qui l'accepte (aucun canal = tous ; Gmail compte pour le mail)", () => {
    const a = attente({ id: "wa", canaux: ["WHATSAPP"] });
    const b = attente({ id: "mail", canaux: ["MAIL"], createdAt: new Date(T0.getTime() + 1000) });
    const c = attente({ id: "tous", canaux: [], createdAt: new Date(T0.getTime() - 1000) });
    expect(attentePourCanal([a, b, c], "WHATSAPP", T0)?.id).toBe("wa");
    expect(attentePourCanal([a, b, c], "GMAIL", T0)?.id).toBe("mail");
    expect(attentePourCanal([c], "MAIL", T0)?.id).toBe("tous");
    expect(attentePourCanal([a], "MAIL", T0)).toBeNull();
  });

  it("LA CONSIGNE : rien sans attente ; une ligne courte chacune, trois au plus", () => {
    expect(sectionAttentes([], T0)).toBeNull();
    expect(sectionAttentes([attente({ etat: "CLOSE" })], T0)).toBeNull();
    const s = sectionAttentes([attente(), attente({ id: "2" }), attente({ id: "3" }), attente({ id: "4" })], T0)!;
    expect(s.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
    expect(s).toContain("lettre de demande du Dr Mansouri → SP-2026-014");
    expect(s).toContain("attendue par WhatsApp");
    // Une attente : moins de ~60 jetons (≈ 4 caractères par jeton).
    expect(sectionAttentes([attente()], T0)!.length).toBeLessThan(260);
    // Reçue : dite « déjà reçue », et une nouvelle annonce rouvre une attente (banc réel du 31/10 : le modèle refusait).
    const recue = sectionAttentes([attente({ etat: "RECUE", recueLe: new Date(T0.getTime() - 60_000) })], T0)!;
    expect(recue).toMatch(/déjà reçue à .*rangement proposé/);
    expect(recue).toContain("annoncée de nouveau (autre ou renvoyée) : attendre_pieces");
  });

  it("le numéro : ses neuf derniers chiffres, quelle que soit l'écriture", () => {
    expect(cleTelephone("0555 98 76 54")).toBe("555987654");
    expect(cleTelephone("+213 (0)5 55 98 76 54")).toBe("555987654");
    expect(cleTelephone("213555987654")).toBe("555987654");
    expect(cleTelephone("0000000000")).toBeNull();
    expect(cleTelephone("1234")).toBeNull();
  });

  it("un expéditeur journalisé masqué", () => {
    expect(masquerExpediteur("213699000111")).toBe("+213•••••0111");
    expect(masquerExpediteur("ali.b@ext.dz")).toBe("a•••@ext.dz");
  });

  it("pièce sensible : identité, banque, paie — ou une fiche RH", () => {
    expect(pieceConfidentielle("Passeport scan.pdf", null)).toBe(true);
    expect(pieceConfidentielle("RIB Société Générale.pdf", null)).toBe(true);
    expect(pieceConfidentielle("Bulletin de paie octobre.pdf", null)).toBe(true);
    expect(pieceConfidentielle("Lettre Dr Mansouri.pdf", "SPONSORING")).toBe(false);
    expect(pieceConfidentielle("attestation.pdf", "EMPLOYEE")).toBe(true);
  });

  it("catégorie proposée d'après ce qui est attendu", () => {
    expect(categorieProposee("lettre de demande du Dr X")).toBe("Lettre de demande");
    expect(categorieProposee("le devis de l'hôtel")).toBe("Devis");
    expect(categorieProposee("photos", "Programme")).toBe("Programme");
  });

  it("ce que l'assistant dit : la pièce, la question, et chaque refus", () => {
    const avec = messageDeReception({ canal: "WHATSAPP", noms: ["Lettre.pdf"], description: "lettre du Dr Mansouri", cibleLibelle: "SP-7", carte: true, confidentiel: false, refusees: [] });
    expect(avec).toContain("J'ai reçu lettre du Dr Mansouri par WhatsApp");
    expect(avec).toContain("Je l'ajoute à SP-7 ?");
    const sans = messageDeReception({ canal: "MAIL", noms: ["x.pdf"], carte: false, confidentiel: true, refusees: ["« y.exe » (format refusé)"] });
    expect(sans).toContain("À quoi la rattacher ?");
    expect(sans).toContain("confidentiel");
    expect(sans).toContain("Non reçue : « y.exe » (format refusé)");
  });
});
