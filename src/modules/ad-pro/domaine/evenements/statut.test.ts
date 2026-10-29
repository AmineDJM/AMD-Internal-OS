import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  STATUTS_MANUELS, STATUTS_DU_CIRCUIT, estStatutManuel, estStatutDuCircuit,
  statutManuelOuRien, statutDepuisCircuit,
} from "./statut";

const lire = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * « DES FOIS UN ÉVÉNEMENT N'EST PAS ENCORE VALIDÉ ET POURTANT SON ÉTAT EST VALIDÉ » (§118.138)
 *
 * Deux vérités sur la même question, et c'est la plus flatteuse qui gagnait. Chaque cas
 * ci-dessous nomme ce qui le ferait tomber — une assertion dont on ne sait pas nommer ce cas
 * n'est pas une assertion (§118.17).
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */
describe("l'état d'un événement : ce qui se tape, et ce qui se décide", () => {
  it("les deux VERDICTS ne sont PAS saisissables à la main", () => {
    // Ce qui le ferait tomber : les remettre dans `STATUTS_MANUELS`. N'importe qui avec
    // EVENTS:UPDATE réécrirait « Validé » sur un événement qu'aucune étape n'a validé.
    expect(estStatutManuel("VALIDATED")).toBe(false);
    expect(estStatutManuel("AWAITING_VALIDATION")).toBe(false);
    expect(statutManuelOuRien("VALIDATED")).toBeNull();
    expect(statutManuelOuRien("AWAITING_VALIDATION")).toBeNull();
  });

  it("les états de VIE restent saisissables — sinon on aurait remplacé un défaut par un blocage", () => {
    // Ce qui le ferait tomber : tout refuser. Un événement ne pourrait plus se clore ni s'annuler —
    // un refus à tort, plus coûteux que le défaut corrigé (§118.27).
    for (const v of STATUTS_MANUELS) expect(statutManuelOuRien(v), v).toBe(v);
    expect(STATUTS_MANUELS).toContain("COMPLETED");
    expect(STATUTS_MANUELS).toContain("CANCELLED");
    // ÉVÉNEMENTS EXTERNES (Direction, 27/10) : les états d'ORGANISATION ne se saisissent plus.
    for (const v of ["PREPARATION", "REGISTRATION_OPEN", "FULL"]) expect(statutManuelOuRien(v), v).toBeNull();
  });

  it("les deux vocabulaires ne se recoupent JAMAIS", () => {
    for (const v of STATUTS_DU_CIRCUIT) expect(estStatutDuCircuit(v), v).toBe(true);
    for (const v of STATUTS_MANUELS) expect(estStatutDuCircuit(v), v).toBe(false);
  });

  it("aucun statut envoyé = « ne touche pas au champ », jamais « remets en brouillon »", () => {
    // Ce qui le ferait tomber : rendre "DRAFT". Un formulaire qui ne porte pas la case
    // ramènerait un événement validé au brouillon, en silence.
    expect(statutManuelOuRien(null)).toBeNull();
    expect(statutManuelOuRien(undefined)).toBeNull();
    expect(statutManuelOuRien("")).toBeNull();
    expect(statutManuelOuRien("N_IMPORTE_QUOI")).toBeNull();
  });
});

describe("le CIRCUIT impose l'état — et se tait sur ce qui ne le regarde pas", () => {
  it("la décision du circuit devient l'état de l'événement", () => {
    expect(statutDepuisCircuit("APPROVED")).toBe("VALIDATED");
    expect(statutDepuisCircuit("AWAITING_PRELIMINARY")).toBe("AWAITING_VALIDATION");
    expect(statutDepuisCircuit("PRELIMINARY_APPROVED")).toBe("AWAITING_VALIDATION");
    expect(statutDepuisCircuit("AWAITING_FINAL")).toBe("AWAITING_VALIDATION");
  });

  it("pas de demande de prise en charge ⇒ le circuit ne dit RIEN de l'état", () => {
    // Un événement peut être organisé sans financement : il est piloté directement.
    expect(statutDepuisCircuit(null)).toBeNull();
    expect(statutDepuisCircuit(undefined)).toBeNull();
  });

  it("un financement REFUSÉ n'annule pas l'événement, mais ne le laisse pas « en attente » non plus", () => {
    // DEUX ERREURS SYMÉTRIQUES, et il faut éviter les deux. « CANCELLED » déciderait de la tenue
    // d'un événement dont on n'a refusé que la prise en charge (§118.15) ; laisser
    // « AWAITING_VALIDATION » annoncerait une validation que plus personne n'instruit. `DRAFT`
    // est le seul état neutre : rien d'engagé, rien de promis.
    expect(statutDepuisCircuit("REJECTED")).toBe("DRAFT");
    expect(statutDepuisCircuit("CANCELLED")).toBe("DRAFT");
    expect(statutDepuisCircuit("COMPLETED"), "le DOSSIER est clos, pas forcément l'événement").toBeNull();
  });
});

/**
 * LES DEUX MOITIÉS SONT BRANCHÉES — au POINT D'APPEL, pas dans le corps (§118.49).
 *
 * `daterLEntree` était écrite, commentée, couverte par un test qui lisait son corps, et son
 * appel avait été perdu dans une édition. Ce test-ci cherche donc les appelants.
 */
describe("les deux moitiés ont leur appelant de production", () => {
  it("le formulaire d'événement filtre le statut saisi — à la CRÉATION comme à la MODIFICATION", () => {
    const src = lire("src/modules/ad-pro/actions-evenements.ts");
    expect(src).toMatch(/\bstatutManuelOuRien\b[^;]*\} from "@\/modules\/ad-pro\/partage"/);
    // Deux appels : `createEvent` et `updateEvent`. Un seul laisserait une porte ouverte à côté
    // d'une porte gardée (§118.71).
    // (`updateEvent` passe l'état actuel : un ancien état d'organisation renvoyé tel quel ne s'écrit pas.)
    expect([...src.matchAll(/statutSaisi\(formData(, avant\.status)?\)/g)].length, "createEvent ET updateEvent").toBe(2);
    // Et plus AUCUNE lecture brute du champ dans un `data:` d'écriture.
    expect(src, "le statut ne se lit plus directement depuis le formulaire").not.toMatch(
      /status: inEnum\(EventStatus, fdStr\(formData, "status"\)/,
    );
  });

  it("le moteur de circuit ÉCRIT l'état de l'événement — sans quoi il resterait « Brouillon » à jamais", () => {
    // Le moteur est découpé (`workflow/engine.ts` + `workflow/engine/*.ts`) : on lit le tout, porte d'abord.
    const morceaux = fs.readdirSync(path.join(process.cwd(), "src/lib/workflow/engine")).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).sort();
    const src = [lire("src/lib/workflow/engine.ts"), ...morceaux.map((f) => lire(`src/lib/workflow/engine/${f}`))].join("\n");
    // TROIS projections : l'avance (`projectApprove`), le refus définitif (`projectReject`), et
    // l'écriture commune au renvoi pour correction, à la pose d'une demande resoumise ou relancée
    // et au retrait (`projeterStatut`, §118.186). En oublier une laisserait un événement refusé, à
    // corriger ou retiré afficher « En attente de validation ».
    expect([...src.matchAll(/statutDepuisCircuit\(/g)].length).toBe(3);
    expect(src, "le renvoi, la pose et le retrait passent par la même écriture").toMatch(/async function projeterStatut[\s\S]{0,400}statutDepuisCircuit\(statut\)/);
    for (const site of ["async function projectReturn", "async function projectPose"]) {
      const corps = src.slice(src.indexOf(site), src.indexOf("\n}\n", src.indexOf(site)));
      expect(corps, `${site} écrit par projeterStatut`).toContain("projeterStatut(");
    }
    // Le retrait SUPPRIME désormais la demande (Direction, 05/10) : il n'y a plus d'état « annulé » à
    // projeter sur un événement qui n'existe plus. `retirerDemande` ne projette donc rien.
    const retrait = src.slice(src.indexOf("export async function retirerDemande"), src.indexOf("\n}\n", src.indexOf("export async function retirerDemande")));
    expect(retrait, "le retrait délègue la suppression et n'écrit plus d'état").toContain("input.supprimer(");
    expect(retrait, "le retrait ne projette plus rien").not.toContain("projeterStatut(");
    expect(src, "la projection se fait dans `projectApprove`, une seule fois pour les deux branches")
      .toMatch(/entityType === "EVENT"[\s\S]{0,400}statutDepuisCircuit/);
  });

  it("le BLOC MANUEL « Suivi de validation » a bien disparu de la fiche d'un événement", () => {
    // ON JUGE LE CODE, PAS LES COMMENTAIRES — et ce test l'a appris sur lui-même, comme trois
    // cliquets avant lui (§118.79d, §118.88, §118.112b). La page CITE le bloc retiré et sa
    // phrase d'invitation pour documenter le défaut fermé : sans retirer les commentaires, les
    // assertions ci-dessous mesureraient cette prose et non le rendu.
    const src = lire("src/app/(app)/events/[id]/page.tsx")
      .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/[^\n]*/g, "");
    expect(src).not.toMatch(/Suivi de validation/);
    expect(src).not.toMatch(/eventValidationSteps/);
    expect(src, "et plus aucune invitation à faire avancer la validation à la main").not.toMatch(/Faites avancer la validation/);
  });
});
