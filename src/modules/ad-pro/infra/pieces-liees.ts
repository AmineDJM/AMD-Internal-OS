import { prisma } from "@/lib/prisma";
import { userCan, type SessionUser } from "@/lib/rbac";
import { companyScopedWhere } from "@/lib/company";
import { legalReaderWhere, legalWriteAllowed } from "@/lib/lecteurs/legal";
import { natureLegale } from "@/lib/labels";
import type { AccesPiecesLiees } from "@/components/pieces/linked-records";

/**
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 * CE QU'UNE FICHE Ad & Pro A LE DROIT DE MONTRER DE SES PIÈCES LIÉES — calculé UNE fois.
 *
 * Trois écrans Ad & Pro montent le bloc des pièces liées (sponsoring, prises en charge,
 * événements) et un quatrième arrive tôt ou tard. Chacun aurait épelé les mêmes droits à sa
 * façon, et chaque orthographe en oublie un : c'est le défaut mesuré de `ad-pro/attachments.ts`
 * (« chacun l'épelait à sa façon, et chaque orthographe oubliait quelqu'un, qui envoyait alors
 * la facture par mail avec un dossier vide »). La règle vit donc ici, et les écrans la lisent.
 *
 * ── LES DEUX CHOSES QU'ELLE RÉPOND ──────────────────────────────────────────────────────
 *
 *   • `acces` — peut-on OUVRIR les documents d'un engagement, d'une facture, d'un courrier
 *     rattachés ? Ces fichiers appartiennent à LEUR module : quelqu'un qui a Ad & Pro sans Legal
 *     voit déjà le titre et le montant de l'engagement, lui ouvrir ses pièces lui donnerait le
 *     contrat. Sans le droit, les documents ne sont pas même CHARGÉS.
 *
 *   • `candidatsLegal` — quels documents Legal peut-on RATTACHER ? La liste est cloisonnée
 *     EXACTEMENT comme celle de l'écran Legal : portée d'entité (`companyScopedWhere`) plus les
 *     lecteurs désignés (`legalReaderWhere`). Une liste plus large proposerait un document que
 *     le serveur refuserait ensuite — un geste offert puis retiré, la pire façon de refuser.
 * ═══════════════════════════════════════════════════════════════════════════════════════════
 */

export interface PiecesLieesContexte {
  acces: AccesPiecesLiees;
  candidatsLegal: { value: string; label: string }[];
}

/**
 * LES DROITS D'UNE PERSONNE SUR LES PIÈCES LIÉES D'UNE FICHE — sans rien lire en base.
 *
 * Deux sortes de fiches montent le bloc : les sept natures Ad & Pro (qui peuvent aussi RATTACHER
 * un document existant, `contextePiecesLiees`) et les demandes du secrétariat. La seconde montait
 * le bloc SANS ces droits : aucun fichier n'y était montré, et chaque bouton de création y était
 * offert à qui gère la demande — y compris ceux que l'action Legal refuse ensuite (§118.161).
 */
export function accesPiecesLiees(user: SessionUser): AccesPiecesLiees {
  const peutLireLegal = userCan(user, "LEGAL", "VIEW") || userCan(user, "FINANCES", "VIEW");
  const peutLireCourriers = userCan(user, "MAIL_REGISTER", "VIEW");

  // CE QU'ON PEUT CRÉER D'ICI, NATURE PAR NATURE — la porte d'écriture de Legal (`legalWriteAllowed`),
  // la même que l'action serveur : les Finances créent factures et bons de commande, Legal crée tout.
  // Un bouton « Devis » offert à qui l'action refusera ensuite ferait chercher la panne (§118.161).
  const creerLegal = (kind: string) => legalWriteAllowed({
    onLegal: userCan(user, "LEGAL", "CREATE"), onFinances: userCan(user, "FINANCES", "CREATE"), kind,
  });

  return {
    legal: peutLireLegal,
    courriers: peutLireCourriers,
    // La personne qui regarde : le bloc lit, PIÈCE PAR PIÈCE, ce que la porte Legal lui ouvrira —
    // lire, déposer, renommer, supprimer (§118.161). RENOMMER ET SUPPRIMER suivent donc le module
    // de la PIÈCE et ses lecteurs désignés, jamais celui de la fiche : le droit de décider d'un
    // sponsoring n'est pas le droit de supprimer la pièce d'un contrat. Les trois drapeaux de
    // module qui tenaient lieu de cette règle (renommer, supprimer, éditer) ont disparu : ils
    // ouvraient les pièces d'un document restreint à qui avait seulement le module.
    spectateur: user,
    creer: {
      devis: creerLegal("QUOTE"),
      bonDeCommande: creerLegal("PURCHASE_ORDER"),
      facture: creerLegal("INVOICE"),
      engagement: creerLegal("AGREEMENT"),
      courrier: userCan(user, "MAIL_REGISTER", "CREATE"),
    },
  };
}

/**
 * `moduleAdPro` est le module de la FICHE (SPONSORING, EVENTS, CONGRESS…) : c'est lui qui dit si
 * la personne peut modifier CE dossier, donc lui rattacher quelque chose. Les droits sur les
 * documents des pièces, eux, viennent de Legal et de Courriers — jamais du module de la fiche.
 */
export async function contextePiecesLiees(
  user: SessionUser,
  moduleAdPro: Parameters<typeof userCan>[1],
): Promise<PiecesLieesContexte> {
  const acces = accesPiecesLiees(user);
  const peutLireLegal = acces.legal ?? false;

  // RATTACHER exige les deux droits : modifier la fiche cible, et voir le document. Sans l'un ou
  // l'autre, la liste est vide et le bouton ne s'affiche pas — plutôt qu'un geste qui échoue.
  const peutRattacher = userCan(user, moduleAdPro, "UPDATE") && peutLireLegal;
  if (!peutRattacher) return { acces, candidatsLegal: [] };

  const lecteurs = legalReaderWhere({ viewerId: user.id, isSuperAdmin: user.role === "SUPER_ADMIN" });
  const libres = await prisma.legalDocument.findMany({
    where: await companyScopedWhere(user.id, {
      // LIBRES : on ne propose pas ce qui est déjà rattaché ailleurs. Le serveur refuserait, en
      // nommant la fiche qui le porte — mais le proposer d'abord ferait chercher pourquoi.
      sourceId: null,
      ...(lecteurs ? { AND: [lecteurs] } : {}),
    }),
    select: { id: true, title: true, reference: true, kind: true },
    orderBy: { createdAt: "desc" },
    take: 60,
  });

  return {
    acces,
    candidatsLegal: libres.map((d) => ({
      value: d.id,
      label: [d.reference, d.title, natureLegale(d.kind)].filter(Boolean).join(" · "),
    })),
  };
}
