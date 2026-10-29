/**
 * FORCE DE VENTE — ce qu'un PRODUIT PROMU reprend avant d'être créé : son dossier Regulatory (nom, référence, produit
 * canonique) et son canal (celui de la BU quand le formulaire ne le dit pas).
 *
 * Sorti de `actions/sales-planning-actions.ts` (lot V4). L'action garde sa porte, l'écriture du produit promu et sa
 * trace ; elle passe le FORMULAIRE à ce corps. Pour le contrat des actions, ce corps est celui du fichier d'actions
 * (`contrat/internes.ts`) : ses champs et ses écrivains importés comptent pour elle.
 */
import { prisma } from "@/lib/prisma";
import { fdStr } from "@/lib/actions/types";
import { DOSSIERS_PROPOSABLES_BU } from "@/lib/sfe/produits-bu";
import { ensureProduitDuDossier } from "@/lib/products/canonique";
import { sansBloquer } from "@/lib/journal";
import { parseChannel } from "@/lib/actions/internes/sales-planning/business-units";

/** `createPromoProduct`, après la porte. `fini` : l'action s'arrête là ; sinon ce que le produit promu portera. */
export async function lireLeProduitPromu(formData: FormData, ctx: { acteurId: string; businessUnitId: string | null }) {
  const { acteurId, businessUnitId } = ctx;
  // LE PRODUIT PROMU VIENT DU DOSSIER RÉGLEMENTAIRE. Le saisir au clavier créait un second
  // référentiel de produits, qui divergeait du premier au premier changement de nom — et rendait
  // impossible de remonter du terrain au dossier. On reprend donc le nom et la référence du
  // dossier ; le nom reste modifiable ensuite (une marque commerciale n'est pas une DCI).
  const regulatoryProductId = fdStr(formData, "regulatoryProductId");
  let name = fdStr(formData, "name");
  let code = fdStr(formData, "code");
  // LE PRODUIT CANONIQUE DU DOSSIER (§118.178) : c'est lui qu'une visite rapporte. Sans lui, le
  // produit ajouté à la BU ne pouvait figurer dans AUCUN rapport — refusé à chaque visite.
  let productId: string | null = null;
  if (regulatoryProductId) {
    // La clause de la LISTE de l'écran : un dossier du pipeline, deviné, n'entre pas au catalogue.
    const dossier = await prisma.regulatoryProduct.findFirst({
      where: { AND: [{ id: regulatoryProductId }, DOSSIERS_PROPOSABLES_BU] },
      select: { reference: true, dci: true, brandName: true, productId: true },
    });
    if (!dossier) return { fini: "Ce dossier Regulatory n'existe pas, ou n'est pas encore ouvert au catalogue promotionnel." };
    name = name || dossier.brandName || dossier.dci;
    code = code || dossier.reference;
    productId = dossier.productId;
    if (!productId) {
      // Produit = dossier : un dossier sans produit (d'avant ce lot) reçoit le sien ici.
      const lien = await ensureProduitDuDossier(regulatoryProductId, { acteurId }).catch(sansBloquer("sales-planning-actions.createPromoProduct.ensureProduitDuDossier", null));
      productId = lien && "produitId" in lien ? lien.produitId : null;
    }
  }
  if (!name) return { fini: "Choisissez un dossier Regulatory, ou donnez un nom de produit." };

  // LE CANAL SUIT LA BU quand le formulaire ne le dit pas : c'est la franchise qui décide du
  // terrain, et redemander la même réponse à chaque produit est le genre de saisie qu'on ne fait
  // qu'une fois — mal.
  let channel = parseChannel(fdStr(formData, "channel"));
  if (!formData.has("channel") && businessUnitId) {
    const bu = await prisma.businessUnit.findUnique({ where: { id: businessUnitId }, select: { channel: true } });
    if (bu) channel = bu.channel;
  }
  return { regulatoryProductId, name, code, productId, channel };
}
