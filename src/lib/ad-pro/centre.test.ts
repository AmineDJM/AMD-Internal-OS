import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  siegeAuCentreAdPro, REFUS_CENTRE_AD_PRO, FORME_PORTE, NATURES_A_VISA,
  visaAutoriseAAvancer, motifBlocageVisa, trierCentre, compteursCentre,
  type LigneCentre, type FormePorte,
} from "./centre";
import { AD_PRO_KINDS } from "./unified";

const ligne = (p: Partial<LigneCentre>): LigneCentre => ({
  kind: "CONSULTING", entityType: "CONSULTING_CONTRACT", entityId: "e1",
  reference: "CONS-1", intitule: "Intitulé", demandeur: "Amel", montant: 2_000_000,
  seuil: 1_000_000, forme: "VISA_CENTRE", depuis: "2026-09-01T00:00:00.000Z",
  href: "/consulting/e1", ...p,
});

describe("qui siège au centre de validation Ad & Pro", () => {
  it("la Direction Générale et le Super Admin, personne d'autre", () => {
    expect(siegeAuCentreAdPro({ role: "GENERAL_MANAGER" })).toBe(true);
    expect(siegeAuCentreAdPro({ role: "SUPER_ADMIN" })).toBe(true);
  });

  /**
   * LA MOITIÉ QUI PROTÈGE. Le siège est une décision d'organisation : la Direction et la
   * Direction Marketing ARBITRENT déjà les demandes Ad & Pro dans leur circuit — leur ouvrir le
   * centre reviendrait à ce qu'elles s'autorisent elles-mêmes le dépassement qu'elles ont
   * proposé. Une garde qu'on n'exerce que dans le sens qui passe ne garde rien (§118.104).
   */
  it("REFUSE la Direction, la Direction Marketing et le reste de l'entreprise", () => {
    for (const role of [
      "DIRECTION", "PRODUCT_MANAGER", "NATIONAL_SALES", "SALES_REP", "FINANCE_BUDGET_MANAGER",
      "OPERATIONS_DIRECTOR", "REGULATORY_MANAGER", "EMPLOYEE",
    ]) {
      expect(siegeAuCentreAdPro({ role }), role).toBe(false);
    }
  });

  it("le DG et le Super Admin y siègent aussi par leur rôle SECONDAIRE (point 26, 27/10)", () => {
    expect(siegeAuCentreAdPro({ role: "PRODUCT_MANAGER", secondaryRole: "GENERAL_MANAGER" })).toBe(true);
    expect(siegeAuCentreAdPro({ role: "DIRECTION", secondaryRole: "SUPER_ADMIN" })).toBe(true);
    // Un rôle secondaire quelconque n'ouvre rien.
    expect(siegeAuCentreAdPro({ role: "PRODUCT_MANAGER", secondaryRole: "DIRECTION" })).toBe(false);
    expect(siegeAuCentreAdPro({ role: "PRODUCT_MANAGER", secondaryRole: null })).toBe(false);
  });

  it("le refus NOMME qui décide — un refus sans remède fait payer un aller-retour", () => {
    expect(REFUS_CENTRE_AD_PRO).toMatch(/Direction Générale/);
    expect(REFUS_CENTRE_AD_PRO).toMatch(/Super Admin/);
  });
});

describe("la forme de porte de CHAQUE nature du pôle", () => {
  /**
   * L'EXHAUSTIVITÉ EST TENUE PAR LE TYPECHECK (`Record<AdProKind, FormePorte>`), mais une nature
   * ajoutée demain au registre canonique doit AUSSI se voir ici : c'est la mesure de départ du
   * lot — 5 natures sur 7 avaient une porte, deux n'en avaient AUCUNE, et un engagement de 5 M
   * DZD passait sans être vu.
   */
  it("les 7 natures du registre canonique ont chacune une forme, et aucune autre", () => {
    const natures = AD_PRO_KINDS.map((k) => k.kind).sort();
    expect(Object.keys(FORME_PORTE).sort()).toEqual(natures);
    expect(natures.length).toBe(7);
    for (const n of natures) {
      expect(["ETAPE_CIRCUIT", "ETAPE_PROMO", "VISA_CENTRE"] as FormePorte[])
        .toContain(FORME_PORTE[n as keyof typeof FORME_PORTE]);
    }
  });

  it("les natures à VISA sont DÉRIVÉES de la table, jamais recopiées", () => {
    // La demande « autre » (nature `OTHER`) a QUITTÉ le visa le 27/10/2026 (décision #17) : elle suit le
    // circuit commun, et le DG valide le total de ses postes. Seul le consulting garde le visa.
    expect(NATURES_A_VISA.slice().sort()).toEqual(["CONSULTING"]);
    expect(FORME_PORTE.OTHER).toBe("ETAPE_CIRCUIT");
    for (const n of NATURES_A_VISA) expect(FORME_PORTE[n]).toBe("VISA_CENTRE");
  });
});

describe("ce qu'un visa autorise", () => {
  it("PENDING et REFUSED bloquent ; APPROVED et « aucun visa » laissent passer", () => {
    expect(visaAutoriseAAvancer("PENDING")).toBe(false);
    expect(visaAutoriseAAvancer("REFUSED")).toBe(false);
    expect(visaAutoriseAAvancer("APPROVED")).toBe(true);
    expect(visaAutoriseAAvancer(null)).toBe(true);
    expect(visaAutoriseAAvancer(undefined)).toBe(true);
  });

  /**
   * POURQUOI « AUCUN VISA » LAISSE PASSER : une demande SOUS le seuil n'en porte aucun, et la
   * très grande majorité des demandes sont dans ce cas. Bloquer par défaut arrêterait tout le
   * pôle Ad & Pro le jour où le visa n'est pas posé — un refus à tort coûte plus cher que le
   * défaut qu'on corrige (§118.27).
   */
  it("les deux blocages DISENT qui décide ; les deux passages ne disent rien", () => {
    expect(motifBlocageVisa("PENDING")).toMatch(/centre de validation/);
    expect(motifBlocageVisa("PENDING")).toMatch(/Rien à faire de votre côté/);
    expect(motifBlocageVisa("REFUSED")).toMatch(/refusé/);
    expect(motifBlocageVisa("APPROVED")).toBeNull();
    expect(motifBlocageVisa(null)).toBeNull();
  });
});

describe("ce que le centre affiche en tête", () => {
  it("la plus VIEILLE en tête, jamais la plus grosse", () => {
    const rows = [
      ligne({ entityId: "grosse", montant: 8_000_000, depuis: "2026-09-18T08:00:00.000Z" }),
      ligne({ entityId: "vieille", montant: 1_100_000, depuis: "2026-09-07T08:00:00.000Z" }),
    ];
    expect(trierCentre(rows).map((r) => r.entityId)).toEqual(["vieille", "grosse"]);
    // Le tri ne MUTE pas son entrée : deux écrans qui lisent la même liste ne se marchent pas dessus.
    expect(rows.map((r) => r.entityId)).toEqual(["grosse", "vieille"]);
  });

  /**
   * LA MOITIÉ QUI COMPTE : `sansMontant`. Additionner les montants connus et présenter la somme
   * comme « engagement total » est une coupe silencieuse — le lecteur croit voir le total, il en
   * voit une partie (§118.60). Le cas qui ferait tomber cette assertion est exactement celui-là :
   * quelqu'un retire le compte et l'écran annonce 2 000 000 pour trois demandes dont deux n'ont
   * pas de montant.
   */
  it("le total voyage avec le NOMBRE de lignes sans montant", () => {
    const c = compteursCentre([
      ligne({ entityId: "a", montant: 2_000_000 }),
      ligne({ entityId: "b", montant: null }),
      ligne({ entityId: "c", montant: 0 }),
    ], new Date("2026-09-21T00:00:00.000Z"));
    expect(c.enAttente).toBe(3);
    expect(c.montantTotal).toBe(2_000_000);
    expect(c.sansMontant).toBe(2);
  });

  it("« dormantes » compte à partir de 7 jours révolus, et pas avant", () => {
    const maintenant = new Date("2026-09-21T12:00:00.000Z");
    const c = compteursCentre([
      ligne({ entityId: "6j", depuis: "2026-09-15T12:00:00.000Z" }),
      ligne({ entityId: "7j", depuis: "2026-09-14T12:00:00.000Z" }),
      ligne({ entityId: "20j", depuis: "2026-09-01T12:00:00.000Z" }),
    ], maintenant);
    expect(c.dormantes).toBe(2);
  });

  it("aucune ligne : des zéros, jamais un NaN dans une jauge", () => {
    const c = compteursCentre([], new Date("2026-09-21T00:00:00.000Z"));
    expect(c).toEqual({ enAttente: 0, dormantes: 0, montantTotal: 0, sansMontant: 0, bonsDeCommande: 0 });
  });

  /**
   * LES BONS DE COMMANDE SE COMPTENT À PART (§118.148). Le BC d'un poste est une part d'une
   * enveloppe DÉJÀ accordée à la demande : l'ajouter au total des demandes compterait deux fois le
   * même argent, et un BC sans montant gonflerait « sans montant » d'une ligne qui n'en est pas
   * une. Le cas qui ferait tomber cette assertion est exactement celui-là : quelqu'un retire le
   * filtre `estFormeBC` et le total passe de 2 000 000 à 2 600 000 sur la même file.
   */
  it("un BC attend au centre, compte dans « en attente », jamais dans le total des demandes", () => {
    const c = compteursCentre([
      ligne({ entityId: "demande", montant: 2_000_000 }),
      ligne({ entityId: "bc-poste", forme: "BC_POSTE", montant: 600_000 }),
      ligne({ entityId: "bc-legal", forme: "BC_LEGAL", montant: null }),
    ], new Date("2026-09-21T00:00:00.000Z"));
    expect(c.enAttente).toBe(3);
    expect(c.bonsDeCommande).toBe(2);
    expect(c.montantTotal).toBe(2_000_000);
    expect(c.sansMontant).toBe(0);
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * LES POINTS D'APPEL — §118.49 : un test qui vérifie le CORPS d'une garde sans vérifier son
 * APPELANT ne teste rien. `daterLEntree` était écrite, commentée, couverte par un test qui
 * lisait son corps, et son appel avait été perdu dans une édition : 2 332 reçus en base, ZÉRO
 * entrée datée.
 *
 * Ici la garde qui compte est `blocageCentreAdPro` dans les DEUX chemins de décision des deux
 * natures à visa. Sans elle, une demande dont le visa est PENDING se ferait trancher par son
 * circuit normal — le seuil serait posé, le centre l'afficherait, et la demande avancerait
 * quand même : le faux succès exact que ce lot existe pour fermer.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("les points d'appel de la garde de visa", () => {
  const lire = (f: string) => readFileSync(f, "utf8");

  it("la nature à visa appelle `blocageCentreAdPro` dans son chemin de DÉCISION", () => {
    const attendus: [string, string, string][] = [
      ["CONSULTING", "src/lib/actions/consulting-actions.ts", "decideConsultingContract"],
    ];
    // Le lot et le registre canonique doivent rester d'accord : une TROISIÈME nature à visa
    // ajoutée demain fait tomber ce test au lieu de partir sans garde (§118.17).
    expect(attendus.map(([k]) => k).sort()).toEqual(NATURES_A_VISA.slice().sort());

    for (const [nature, fichier, fonction] of attendus) {
      const src = lire(fichier);
      expect(src, `${nature} : l'import de la garde`).toContain("blocageCentreAdPro");
      // Le point d'appel doit être DANS la fonction de décision, pas ailleurs dans le fichier :
      // exiger seulement que le FICHIER la contienne laisserait passer une décision ajoutée à
      // côté de la porte gardée (§118.71, §118.137).
      const deb = src.indexOf(`export async function ${fonction}`);
      expect(deb, `${nature} : ${fonction} doit exister`).toBeGreaterThan(-1);
      const suivante = src.indexOf("\nexport async function ", deb + 1);
      const corps = src.slice(deb, suivante === -1 ? undefined : suivante);
      expect(corps, `${nature} : ${fonction} doit APPELER la garde`).toMatch(/blocageCentreAdPro\s*\(/);
    }
  });

  it("la nature à visa POSE le visa sur son chemin d'entrée ; la demande « autre » ouvre le circuit", () => {
    expect(lire("src/lib/actions/consulting-actions.ts")).toMatch(/poserVisaAdPro\s*\(/);
    // 27/10/2026 (décision #17) : plus de visa à la création d'une « autre » — le circuit naît avec elle.
    const autre = lire("src/lib/actions/ad-pro-other-actions.ts");
    expect(autre).not.toMatch(/poserVisaAdPro\s*\(/);
    expect(autre).toMatch(/ouvrirLeCircuit\(\s*"AD_PRO_OTHER"/);
  });

  /**
   * LE SEUIL SE RÈGLE DEPUIS LE CENTRE — c'est la demande, mot pour mot. Une action que
   * l'écran ne peut pas appeler est une promesse d'écran (§118.45, §118.123) : on exige donc
   * que l'écran du centre porte le formulaire, et que l'action ouvre bien sa porte au siège.
   */
  it("le seuil est réglable DEPUIS le centre, et l'action ouvre sa porte au siège", () => {
    expect(lire("src/app/(app)/centre-ad-pro/centre-board.tsx")).toMatch(/setAdProDgThreshold/);
    const settings = lire("src/lib/actions/settings-actions.ts");
    const deb = settings.indexOf("export async function setAdProDgThreshold");
    expect(deb).toBeGreaterThan(-1);
    const suivante = settings.indexOf("\nexport async function ", deb + 1);
    const corps = settings.slice(deb, suivante === -1 ? undefined : suivante);
    expect(corps).toMatch(/siegeAuCentreAdPro\s*\(/);
    // Et les DEUX écrans sont rafraîchis : sans cette ligne, régler le seuil depuis le centre
    // laisserait l'écran d'administration afficher l'ancienne valeur (§118.5).
    expect(corps).toMatch(/revalidatePath\("\/centre-ad-pro"\)/);
    expect(corps).toMatch(/revalidatePath\("\/admin"\)/);
  });
});
