import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DELETE_REGISTRY, DELETABLE_KINDS, type DeletableKind } from "./admin-delete-registry";

/** Un cliquet juge le CODE, pas la prose qui le décrit (§118.79d, §118.88, §118.112b). */
function sansCommentaires(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const lire = (p: string) => sansCommentaires(readFileSync(p, "utf8"));

// Le cœur de la suppression réversible a quitté le fichier d'actions (§118.162) : un fichier
// `"use server"` exporte des points d'entrée publics, et une fonction qui prend un type et un
// identifiant sans vérifier qui appelle n'a rien à y faire. Les ACTIONS restent la porte.
const CŒUR = "src/lib/suppression/coeur.ts";
const ACTIONS = "src/lib/actions/admin-delete-actions.ts";
const ADAM = "src/lib/assistant.ts";

describe("Registre des suppressions — le refus et la réserve", () => {
  it("les trois nouveaux types sont au registre, et le compte est mesuré", () => {
    for (const k of ["CONVERSATION", "NOTIFICATION"] as DeletableKind[]) {
      expect(DELETABLE_KINDS, `${k} doit être supprimable`).toContain(k);
      const spec = DELETE_REGISTRY[k];
      expect(spec.model, `${k} doit nommer son délégué Prisma`).toBeTruthy();
      expect(spec.redirect).toBe("/admin/messagerie");
    }
    // 28 → 30 : le contrat de consulting et l'« autre demande » Ad & Pro, les deux natures du
    // pôle qui n'avaient AUCUNE suppression (§118.162).
    // 30 → 32 : l'article du catalogue promotionnel et l'article de stock (§118.164) — deux types
    // qui REFUSENT quand ils ont servi : on les archive, on n'efface pas une histoire.
    // 32 → 33 : l'appel d'offres PCH (§118.185, I17) — supprimé d'un seul `delete`, sans
    // corbeille, il emportait ses lots, ses bons et ses livraisons sans retour possible.
    // 33 → 34 : le poste d'une demande Ad & Pro (§118.187, R11) — « Retirer le poste » l'effaçait
    // définitivement, avec l'historique de ses décisions en cascade.
    // 34 → 35 : le lot d'un appel d'offres PCH (vague « restes ») — un seul `delete`, sans corbeille ni
    // journal ; il part en lot avec ses affectations à des BU, et REFUSE quand quelque chose en découle.
    // 35 → 36 : la demande de paiement (19/10/2026) — retirée, elle restait à vie dans la liste de son demandeur ; elle
    // part en lot avec son ordre annulé, et REFUSE tant qu'elle est vivante ou que son paiement est sorti.
    // 36 → 37 : un élément du Drive supprimé depuis la corbeille du Drive (10/2026) — il était effacé, octets
    // compris ; il part désormais en lot (versions, partages, commentaires) dans la corbeille du Super Admin.
    expect(DELETABLE_KINDS).toHaveLength(37);
  });

  it("le poste Ad & Pro part EN LOT et ne refuse rien lui-même — c'est le lot qui refuse ce qui a quitté l'ERP", () => {
    // Un ordre réglé, du matériel du stock dehors, une pièce signée : `faitIrreversible`, une seule
    // copie de la règle. La recopier ici ferait deux refus qui finiraient par diverger (§118.5).
    expect(DELETE_REGISTRY.AD_PRO_ITEM.lot, "il part avec ses décisions, ses pièces et ses demandes").toBe(true);
    expect(DELETE_REGISTRY.AD_PRO_ITEM.refuse).toBeUndefined();
    // Tout ce qui part revient : une réserve y serait une promesse de perte qui n'a pas lieu (§118.141c).
    expect(DELETE_REGISTRY.AD_PRO_ITEM.reserve).toBeUndefined();
  });

  it("le catalogue et le stock promotionnels refusent AVANT le clic, sans réserve", () => {
    for (const k of ["PROMO_CATALOGUE", "PROMO_STOCK_ITEM"] as DeletableKind[]) {
      expect(DELETE_REGISTRY[k].refuse, `${k} refuse quand il a servi`).toBeTypeOf("function");
      expect(DELETE_REGISTRY[k].reserve).toBeUndefined();
    }
  });

  it("une conversation refuse, une notification non — et chacune dit pourquoi", () => {
    // Le REFUS n'existe que là où un type a une raison de refuser. Le poser partout ferait
    // payer une requête à chaque suppression du parc, pour rien.
    expect(DELETE_REGISTRY.CONVERSATION.refuse).toBeTypeOf("function");
    expect(DELETE_REGISTRY.NOTIFICATION.refuse).toBeUndefined();
    // La RÉSERVE ne vit que là où la cascade emporte le contenu de l'objet : une notification
    // se restaure à l'identique, donc une réserve y serait du bruit (§118.32).
    expect(DELETE_REGISTRY.CONVERSATION.reserve).toMatch(/VIDE/);
    expect(DELETE_REGISTRY.NOTIFICATION.reserve).toBeUndefined();
  });

  it("les autres types ne refusent rien et ne réservent rien — l'ajout n'a rien changé chez eux", () => {
    // FIELD_REPORT (§118.204) : un compte rendu qui porte du matériel remis justifie des sorties du stock —
    // la corbeille lit le MÊME refus que l'action (`refusSuppressionRapport`), éprouvé dans
    // `rapport-terrain-remises-flow.test.ts`, avec son témoin (un compte rendu sans remise part toujours).
    const AVEC_REFUS: readonly string[] = ["CONVERSATION", "NOTIFICATION", "PROMO_CATALOGUE", "PROMO_STOCK_ITEM", "PCH_TENDER_LINE", "FIELD_REPORT", "LEGAL_DOCUMENT", "PAYMENT_REQUEST"];
    // LEGAL_DOCUMENT (§118.209) : une pièce signée, réglée ou dont une autre découle ne se supprime pas ; le refus
    // vit chez l'écrivain (`refusSuppressionDeLaPiece`), éprouvé dans `legal-suppression-flow`.
    // PAYMENT_REQUEST (19/10/2026) : une demande vivante, un compagnon, un paiement sorti ne se suppriment pas
    // (`refusDeSuppression`), éprouvé dans `paiement-montant-retrait-flow`.
    const anciens = DELETABLE_KINDS.filter((k) => !AVEC_REFUS.includes(k));
    // 28 → 29 : l'appel d'offres PCH ne refuse ni ne réserve rien lui-même — c'est le LOT qui
    // refuse une facture réglée ou une pièce signée parmi ses branches (`faitIrreversible`).
    // 29 → 30 : le poste d'une demande Ad & Pro (§118.187), pour la même raison.
    // 28 → 29 (10/2026) : l'élément du Drive, qui ne refuse ni ne réserve rien — tout ce qui part revient.
    expect(anciens).toHaveLength(29);
    for (const k of anciens) {
      expect(DELETE_REGISTRY[k].refuse, `${k} ne refusait rien avant ce lot`).toBeUndefined();
      expect(DELETE_REGISTRY[k].reserve, `${k} n'annonçait aucune réserve avant ce lot`).toBeUndefined();
    }
  });
});

/**
 * LE CLIQUET DE POSITION (§118.17, §118.49).
 *
 * Une garde se place AVANT, jamais après le clic. Le refus doit donc être lu avant tout
 * instantané dans le cœur partagé, ET avant la construction de la carte chez Adam — sinon le
 * geste est offert puis retiré, ce que §118.83 interdit.
 */
describe("Cliquet — le refus est lu AVANT, aux deux portes", () => {
  it("le cœur partagé lit le refus avant le premier instantané — et avant le lot", () => {
    const src = lire(CŒUR);
    const iRefus = src.indexOf("spec.refuse(id)");
    const iSnapshot = src.indexOf("deleteDelegateOf(spec).findUnique");
    const iLot = src.indexOf("supprimerAvecBranches(kind");
    expect(iRefus, "supprimerReversible doit appeler spec.refuse").toBeGreaterThan(-1);
    expect(iSnapshot).toBeGreaterThan(-1);
    expect(iLot, "le lot doit être appelé par le cœur").toBeGreaterThan(-1);
    expect(iRefus, "le refus doit précéder l'instantané").toBeLessThan(iSnapshot);
    expect(iRefus, "le refus doit précéder le lot").toBeLessThan(iLot);
  });

  it("les actions passent par le cœur — aucune ne supprime par son propre chemin", () => {
    const src = lire(ACTIONS);
    // QUATRE portes, un seul cœur : la suppression du Super Admin, celle du créateur, celle d'une
    // demande Ad & Pro par le directeur des opérations ou la directrice marketing (§118.175), et la
    // suppression GROUPÉE des écritures « à imputer » (§118.176) — chaque élément de la sélection
    // passe par le cœur, un par un, avec son refus lu avant.
    expect(src.match(/supprimerReversible\(/g)?.length ?? 0, "superAdminDelete, deleteOwnRecord, supprimerDemandeAdPro ET superAdminDeleteMany").toBe(4);
    for (const fn of ["superAdminDelete", "deleteOwnRecord", "supprimerDemandeAdPro", "superAdminDeleteMany"]) {
      const corps = src.slice(src.indexOf(`export async function ${fn}(`));
      const fin = corps.indexOf("\nexport ", 1);
      expect((fin > 0 ? corps.slice(0, fin) : corps).includes("supprimerReversible("), `${fn} passe par le cœur`).toBe(true);
    }
    expect(src).not.toContain("spec.remove(");
  });

  it("Adam lit le refus avant de construire la carte de confirmation", () => {
    // Le refus vient désormais de l'APERÇU (§118.162), qui lit `spec.refuse` puis l'inventaire du
    // lot — la même lecture que la fenêtre de l'écran.
    const src = lire(ADAM);
    const iApercu = src.indexOf("apercuSuppression(rawKind, target.id)");
    const iRefus = src.indexOf("if (apercu.refus) return { error: apercu.refus }");
    const iCarte = src.indexOf("const confirmText = target.name.includes");
    expect(iApercu, "delete_record doit lire l'aperçu").toBeGreaterThan(-1);
    expect(iRefus, "delete_record doit rendre le refus de l'aperçu").toBeGreaterThan(-1);
    expect(iCarte).toBeGreaterThan(-1);
    expect(iRefus, "le refus doit précéder la carte — pas un geste offert puis retiré").toBeLessThan(iCarte);
  });

  it("la réserve du registre atteint la carte d'Adam", () => {
    // Une réserve calculée que personne n'affiche est du code mort (§118.50).
    expect(lire(ADAM)).toContain("spec.reserve");
  });
});

describe("La phrase de la confirmation ne contredit pas le code", () => {
  const BOUTON = "src/components/shared/super-admin-delete.tsx";

  it("la suppression dépose un instantané — c'est la PRÉMISSE de tout ce qui suit", () => {
    // Sans ce fait, les deux assertions suivantes n'auraient aucune raison d'être : c'est lui
    // qui rend « irréversible » faux (§118.104 — on vérifie la prémisse). Deux dépôts : l'élément
    // seul, et le lot (dans la transaction qui supprime).
    const src = lire(CŒUR);
    expect(src).toContain("prisma.deletedRecord.create");
    expect(src).toContain("tx.deletedRecord.create");
    expect(lire(ACTIONS)).toContain("superAdminDelete");
  });

  it("elle n'annonce pas une irréversibilité que la corbeille dément", () => {
    const src = readFileSync(BOUTON, "utf8");
    // On lit le fichier ENTIER ici, commentaires compris : une phrase affichée vit dans du
    // JSX, et l'en-tête CITE l'ancienne formule pour documenter le défaut — on cible donc la
    // formule exacte qui était rendue, pas le mot dans la prose.
    expect(src).not.toContain("Cette action ne peut pas être annulée.");
    expect(src).not.toContain('description="Action réservée au Super Admin — irréversible."');
  });

  it("elle NOMME la corbeille, qui est le geste de retour", () => {
    const src = readFileSync(BOUTON, "utf8");
    expect(src).toContain("Corbeille");
  });
});

describe("L'écran d'administration ne propose jamais ce que le registre refuse", () => {
  it("CHAQUE requête de conversation est bornée aux groupes et aux canaux", () => {
    // Afficher les tête-à-tête offrirait un bouton qui refuse — une fausse promesse pire que
    // l'absence (§118.27, §118.83).
    //
    // La première version de cette assertion cherchait la clause N'IMPORTE OÙ dans le fichier :
    // un sabotage qui débornait la LISTE en laissant le COMPTE intact passait au vert, parce que
    // le littéral restait présent (§118.111 — un sabotage qui passe dit « je ne teste pas ce que
    // je crois »). On juge donc requête par requête : un troisième accès ajouté demain devra
    // déclarer sa portée, et l'échec le NOMME.
    const src = lire("src/app/(app)/admin/messagerie/page.tsx");
    const acces = src.split("prisma.conversation.").slice(1);
    expect(acces.length, "l'écran doit interroger les conversations").toBeGreaterThanOrEqual(2);
    acces.forEach((frag, i) => {
      const fin = frag.indexOf("take:") >= 0 ? frag.indexOf("take:") : 400;
      const entete = frag.slice(0, Math.max(fin, 120));
      expect(entete, `l'accès #${i + 1} aux conversations n'est pas borné aux GROUP/CHANNEL`)
        .toContain('type: { in: ["GROUP", "CHANNEL"] }');
    });
    expect(src).not.toMatch(/type:\s*"DIRECT"/);
  });

  it("aucun corps de message n'est lu par cet écran", () => {
    // La lecture de la messagerie est cloisonnée par appartenance : un écran d'administration
    // qui sélectionnerait `body` d'un message serait une porte dérobée (§118.7).
    const src = lire("src/app/(app)/admin/messagerie/page.tsx");
    expect(src).not.toContain("prisma.message.");
    expect(src).not.toMatch(/messages:\s*\{\s*select/);
  });
});
