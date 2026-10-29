import { describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import {
  ENTITE_DU_MODELE, LIBELLE_DU_MODELE, LIENS_DIRECTS, REFERENCES_TEXTE, REFERENTS, faitIrreversible,
} from "./branches";
import { RELATIONS, ouIdentite } from "./lot";
import { DELETE_REGISTRY, DELETABLE_KINDS, modeleDuRegistre } from "@/lib/admin-delete-registry";
import { AD_PRO_ENTITY_TYPE, AD_PRO_KINDS } from "@/modules/ad-pro/partage";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LE CLIQUET DES BRANCHES (§118.162) — il lit le SCHÉMA, pas une liste écrite à côté.
 *
 * La table des couples (type, identifiant) est la seule décision humaine du lot de suppression :
 * tout le reste (enfants en cascade, liens mis à vide, ordre de recréation) se lit dans le schéma
 * au moment de supprimer. Une décision humaine prend du retard en silence — un couple ajouté
 * demain sans classement redeviendrait le silence qu'on vient de fermer : une déclaration qui
 * survit à sa demande. Ce banc le fait tomber, en nommant le couple.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

const MODELES = Prisma.dmmf.datamodel.models;
const PAR_NOM = new Map(MODELES.map((m) => [m.name, m]));
const TYPES_ENTITE = new Set(
  Prisma.dmmf.datamodel.enums.find((e) => e.name === "EntityType")!.values.map((v) => v.name),
);

/**
 * Un couple POLYMORPHE : `xType` + `xId`, où `xType` peut porter n'importe quel type d'entité —
 * l'énumération `EntityType`, ou un texte libre. `RegulatoryProduct.productType` / `productId`
 * a la forme sans le fond (son type est `ProductType`, une nature de produit) : la règle le
 * laisse dehors, et c'est l'un des cas qui la tiennent.
 */
function couplesDuSchema(): string[] {
  const out: string[] = [];
  for (const m of MODELES) {
    const noms = new Set(m.fields.map((f) => f.name));
    for (const f of m.fields) {
      if (f.kind === "object" || !f.name.endsWith("Type")) continue;
      const champId = `${f.name.slice(0, -4)}Id`;
      if (!noms.has(champId)) continue;
      const polymorphe = (f.kind === "enum" && f.type === "EntityType") || (f.kind === "scalar" && f.type === "String");
      if (polymorphe) out.push(`${m.name}.${f.name}/${champId}`);
    }
  }
  return out.sort();
}

const cleReferent = (r: { modele: string; champType: string; champId: string }) => `${r.modele}.${r.champType}/${r.champId}`;

describe("Branches — chaque couple (type, identifiant) du schéma a une conduite", () => {
  it("tous les couples du schéma sont classés, et aucun classement ne vise un couple absent", () => {
    const schema = couplesDuSchema();
    const classes = REFERENTS.map(cleReferent).sort();
    const nonClasses = schema.filter((c) => !classes.includes(c));
    const fantomes = classes.filter((c) => !schema.includes(c));
    expect(nonClasses, "couple(s) sans conduite — EMPORTEE, COEUR ou HISTOIRE, avec la raison").toEqual([]);
    expect(fantomes, "classement(s) d'un couple qui n'existe pas (ou plus) au schéma").toEqual([]);
    // Mesuré : 32 couples. Un compte qui baisse sans raison dirait que la détection s'est cassée.
    expect(schema.length).toBeGreaterThanOrEqual(32);
  });

  it("la règle de détection laisse dehors un couple qui n'a que la forme (RegulatoryProduct)", () => {
    // Prémisse : le champ existe bien avec cette forme — sans elle, ce cas passerait pour rien.
    const rp = PAR_NOM.get("RegulatoryProduct")!;
    expect(rp.fields.some((f) => f.name === "productType" && f.kind === "enum" && f.type !== "EntityType")).toBe(true);
    expect(couplesDuSchema()).not.toContain("RegulatoryProduct.productType/productId");
  });

  it("chaque classement porte une raison — une conduite sans raison est un choix que personne ne pourra relire", () => {
    for (const r of REFERENTS) expect(r.raison.trim().length, cleReferent(r)).toBeGreaterThan(20);
  });

  it("LA décision de la Direction : la déclaration d'information médicale part avec sa demande", () => {
    const decl = REFERENTS.find((r) => r.modele === "MedicalInfoDeclaration");
    expect(decl?.conduite).toBe("EMPORTEE");
  });

  it("le journal ne s'efface jamais avec la demande", () => {
    for (const modele of ["AuditLog", "BusinessEvent"]) {
      expect(REFERENTS.find((r) => r.modele === modele)?.conduite, modele).toBe("HISTOIRE");
    }
  });
});

describe("Branches — les tables que le lot lit existent, et parlent la bonne langue", () => {
  it("ENTITE_DU_MODELE : chaque modèle existe, et chaque type est un type d'entité", () => {
    for (const [modele, type] of Object.entries(ENTITE_DU_MODELE)) {
      expect(PAR_NOM.has(modele), `modèle ${modele}`).toBe(true);
      expect(TYPES_ENTITE.has(type), `${modele} → ${type}`).toBe(true);
    }
  });

  it("une branche EMPORTÉE s'interroge sans erreur : son champ de type accepte TOUT type d'entité", () => {
    // Un champ de type ÉNUMÉRÉ plus étroit que `EntityType` ferait échouer la requête d'inventaire
    // sur une valeur hors énumération — et avec elle TOUTE la suppression. Mesuré : il n'y en a
    // aucun ; ce cas dit pourquoi il ne faut pas en ajouter un sans y penser.
    for (const r of REFERENTS.filter((x) => x.conduite === "EMPORTEE")) {
      const f = PAR_NOM.get(r.modele)!.fields.find((x) => x.name === r.champType)!;
      const accepteTout = (f.kind === "enum" && f.type === "EntityType") || (f.kind === "scalar" && f.type === "String");
      expect(accepteTout, `${cleReferent(r)} est typé ${f.type}`).toBe(true);
    }
  });

  it("LIENS_DIRECTS : un champ TEXTE qui existe, vers un modèle qui existe — et qu'aucune clé étrangère ne porte", () => {
    // S'ils étaient des clés étrangères, le lot les connaîtrait par le schéma et cette table
    // serait une seconde vérité (§118.5). Ils sont écrits ici PARCE QUE Postgres ne les voit pas.
    for (const l of LIENS_DIRECTS) {
      const f = PAR_NOM.get(l.modele)!.fields.find((x) => x.name === l.champ);
      expect(f?.kind === "scalar" && f.type === "String", `${l.modele}.${l.champ} doit être un texte`).toBe(true);
      expect(PAR_NOM.get(l.cible)?.fields.some((x) => x.isId && x.name === "id"), `cible ${l.cible}`).toBe(true);
      expect(RELATIONS.some((r) => r.enfant === l.modele && r.champ === l.champ), `${l.modele}.${l.champ} est devenu une clé étrangère : retirez-le d'ici`).toBe(false);
    }
  });

  it("REFERENCES_TEXTE (§118.176) : un champ TEXTE qui existe, vers un modèle qui existe, qu'aucune clé ne porte — et un nom pour le dire", () => {
    // La même exigence que `LIENS_DIRECTS` : écrites ici PARCE QUE Postgres ne les voit pas. Et la
    // ligne qui RESTE doit avoir un nom : l'aperçu dit « 1 ordre de dépense perd son lien », pas
    // « 1 ExpenseOrder ».
    for (const l of REFERENCES_TEXTE) {
      const f = PAR_NOM.get(l.modele)!.fields.find((x) => x.name === l.champ);
      expect(f?.kind === "scalar" && f.type === "String", `${l.modele}.${l.champ} doit être un texte`).toBe(true);
      expect(PAR_NOM.get(l.cible)?.fields.some((x) => x.isId && x.name === "id"), `cible ${l.cible}`).toBe(true);
      expect(RELATIONS.some((r) => r.enfant === l.modele && r.champ === l.champ), `${l.modele}.${l.champ} est devenu une clé étrangère : retirez-le d'ici`).toBe(false);
      expect(LIBELLE_DU_MODELE[l.modele], `${l.modele} sans nom lisible`).toBeDefined();
    }
  });

  it("REFERENCES_TEXTE ne font JAMAIS entrer leur ligne dans le lot — deux listes, deux questions", () => {
    // Mêlées à `LIENS_DIRECTS`, elles seraient suivies dans l'autre sens : supprimer un ordre de
    // dépense emporterait l'écriture de trésorerie qui le règle. Aucune paire ne doit figurer dans
    // les deux listes.
    const directs = new Set(LIENS_DIRECTS.map((l) => `${l.modele}.${l.champ}`));
    expect(REFERENCES_TEXTE.filter((l) => directs.has(`${l.modele}.${l.champ}`))).toEqual([]);
  });

  it("tout ce qui peut partir avec une demande porte un nom en français", () => {
    // La fermeture : les têtes de lot, puis — niveau par niveau — leurs enfants en cascade, leurs
    // branches emportées et leurs liens directs. Chaque modèle atteint apparaît dans « Part aussi
    // avec lui » ; sans libellé, la personne lirait « 3 ValidationItemDecision ».
    const tetes = DELETABLE_KINDS.filter((k) => DELETE_REGISTRY[k].lot).map((k) => modeleDuRegistre(DELETE_REGISTRY[k]));
    const emportees = [...new Set(REFERENTS.filter((r) => r.conduite === "EMPORTEE").map((r) => r.modele))];
    const vus = new Set<string>(tetes);
    let frontiere = [...tetes];
    while (frontiere.length) {
      const suivante: string[] = [];
      const ajouter = (m: string) => { if (!vus.has(m)) { vus.add(m); suivante.push(m); } };
      for (const m of frontiere) {
        for (const r of RELATIONS) if (r.parent === m && r.action === "Cascade") ajouter(r.enfant);
        if (ENTITE_DU_MODELE[m]) emportees.forEach(ajouter);
        for (const l of LIENS_DIRECTS) if (l.modele === m) ajouter(l.cible);
      }
      frontiere = suivante;
    }
    // Une tête n'est jamais sa propre branche — sauf une déclaration, qui est les deux.
    const branches = [...vus].filter((m) => !tetes.includes(m) || emportees.includes(m));
    const sansNom = branches.filter((m) => !LIBELLE_DU_MODELE[m]);
    expect(sansNom, "modèle(s) qui partiraient avec une demande sans nom lisible").toEqual([]);
    // Mesuré : 43 modèles peuvent partir comme branches. Un compte qui s'effondre dirait que la
    // fermeture a cessé de suivre les cascades.
    expect(branches.length).toBeGreaterThanOrEqual(40);
  });
});

describe("Registre — toute demande Ad & Pro part avec ses branches", () => {
  it("les SEPT natures du pôle ont une suppression, et c'est un LOT", () => {
    // Décision de la Direction (30/09/2026) : « toute demande doit être liée du début à la fin à
    // toutes ses branches ». Elle ne pouvait pas valoir pour cinq natures sur sept : le consulting
    // et l'« autre demande » n'avaient aucune suppression. Une huitième nature ajoutée demain
    // fera tomber ce cas tant que personne ne lui aura donné la sienne.
    for (const nature of AD_PRO_KINDS) {
      const type = AD_PRO_ENTITY_TYPE[nature.kind];
      const kinds = DELETABLE_KINDS.filter((k) => DELETE_REGISTRY[k].entityType === type);
      expect(kinds, `${nature.kind} (${type}) doit avoir UNE suppression au registre`).toHaveLength(1);
      expect(DELETE_REGISTRY[kinds[0]!].lot, `${nature.kind} doit emporter ses branches`).toBe(true);
    }
  });

  it("la déclaration d'information médicale supprimée SEULE emporte aussi ses branches", () => {
    expect(DELETE_REGISTRY.MEDICAL_INFO_DECLARATION.lot).toBe(true);
  });

  it("chaque lot désigne un modèle réel, et son type d'entité est celui que le lot lit", () => {
    // Sans cet accord, les pièces jointes, commentaires et branches de la TÊTE ne seraient pas
    // trouvés : le lot les chercherait sous un autre type — ou sous aucun.
    for (const k of DELETABLE_KINDS.filter((x) => DELETE_REGISTRY[x].lot)) {
      const spec = DELETE_REGISTRY[k];
      const modele = modeleDuRegistre(spec);
      expect(PAR_NOM.has(modele), `${k} → ${modele}`).toBe(true);
      expect(ENTITE_DU_MODELE[modele], `${k} : ENTITE_DU_MODELE[${modele}]`).toBe(spec.entityType);
    }
  });
});

describe("Faits irréversibles — la demande reste quand elle justifie un fait qui a quitté l'ERP", () => {
  it("chaque champ lu par la garde EXISTE au schéma — sinon la garde lit `undefined` pour toujours", () => {
    // §118.17 : une garde qui lit un champ absent ne peut pas tomber. On vérifie la prémisse.
    const lus: Record<string, string[]> = {
      ExpenseOrder: ["status", "paidDate", "transactionId"],
      LegalDocument: ["paidDate", "settlementTxId", "signedById", "signedAt"],
      MedicalInfoDeclaration: ["authorityRef"],
    };
    for (const [modele, champs] of Object.entries(lus)) {
      for (const c of champs) expect(PAR_NOM.get(modele)!.fields.some((f) => f.name === c), `${modele}.${c}`).toBe(true);
    }
    const statuts = Prisma.dmmf.datamodel.enums.find((e) => e.name === "ExpenseOrderStatus")!.values.map((v) => v.name);
    expect(statuts).toContain("PAID");
  });

  it("règlement, signature, dépôt aux autorités, courrier inscrit — chacun nommé", () => {
    expect(faitIrreversible("ExpenseOrder", { reference: "OD-1", status: "PAID" })).toMatch(/OD-1.*réglé/);
    expect(faitIrreversible("ExpenseOrder", { reference: "OD-2", status: "PENDING", paidDate: new Date() })).toMatch(/réglé/);
    expect(faitIrreversible("ExpenseOrder", { reference: "OD-3", status: "PENDING", transactionId: "t" })).toMatch(/réglé/);
    expect(faitIrreversible("LegalDocument", { reference: "F-1", paidDate: new Date() })).toMatch(/F-1.*réglée/);
    expect(faitIrreversible("LegalDocument", { reference: "F-2", settlementTxId: "t" })).toMatch(/réglée/);
    expect(faitIrreversible("LegalDocument", { reference: "BC-1", signedById: "u" })).toMatch(/BC-1.*signée par les Finances/);
    expect(faitIrreversible("LegalDocument", { title: "Contrat", signedAt: new Date() })).toMatch(/Contrat.*signée/);
    expect(faitIrreversible("MedicalInfoDeclaration", { reference: "DIM-1", authorityRef: "R-9" })).toMatch(/DIM-1.*R-9/);
    expect(faitIrreversible("MailEntry", { reference: "CR-1" })).toMatch(/CR-1.*registre/);
  });

  it("ce qui n'a pas quitté l'ERP ne bloque rien — sinon aucune demande ne partirait", () => {
    expect(faitIrreversible("ExpenseOrder", { reference: "OD", status: "PENDING" })).toBeNull();
    expect(faitIrreversible("ExpenseOrder", { reference: "OD", status: "CANCELLED" })).toBeNull();
    expect(faitIrreversible("LegalDocument", { reference: "Devis" })).toBeNull();
    expect(faitIrreversible("MedicalInfoDeclaration", { reference: "DIM" })).toBeNull();
    expect(faitIrreversible("AdministrativeRequest", { reference: "SEC" })).toBeNull();
  });
});

describe("La condition de suppression désigne UNE ligne, jamais toute la table", () => {
  it("une clé primaire simple manquante est refusée", () => {
    // `deleteMany({ where: { id: undefined } })` ne filtre RIEN sous Prisma : il viderait la table.
    expect(() => ouIdentite("SponsoringRequest", {})).toThrow(/absente/);
    expect(() => ouIdentite("SponsoringRequest", { id: "" })).toThrow(/absente/);
    expect(ouIdentite("SponsoringRequest", { id: "x", reference: "SP" })).toEqual({ id: "x" });
  });

  it("une clé COMPOSÉE exige toutes ses parties", () => {
    // Prémisse : `CareQuoteCell` n'a pas d'`id` — c'est ce qui rend le cas réel.
    expect(PAR_NOM.get("CareQuoteCell")!.fields.some((f) => f.isId)).toBe(false);
    expect(() => ouIdentite("CareQuoteCell", { quoteId: "q" })).toThrow(/absente/);
    expect(ouIdentite("CareQuoteCell", { quoteId: "q", cellId: "c", amount: 1 })).toEqual({ quoteId: "q", cellId: "c" });
  });
});
