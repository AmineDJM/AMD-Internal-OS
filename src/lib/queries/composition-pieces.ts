import { userCan } from "@/lib/rbac";
import type { CurrentUser } from "@/lib/session";
import { getMyCompanies, companyLabel, companyIdForNew } from "@/lib/company";
import { legalWriteAllowed } from "@/lib/legal/invoices";
import { letterheadContextFor } from "@/lib/queries/letterheads";
import { canManageLetterheads } from "@/lib/office/letterhead";
import type { AmontComposable, TypePieceComposable } from "@/components/pieces/composer-piece";
import { NATURES_AMONT } from "@/lib/legal/piece-emise";
import { piecesAmontComposables } from "@/lib/queries/legal-chain";

/**
 * CE QU'IL FAUT POUR COMPOSER UNE PIÈCE — les natures qu'on a le droit d'émettre, les sociétés
 * qu'on peut engager, la papeterie Word, et le droit de régler la numérotation.
 *
 * Deux écrans portent le bouton « Composer » : Legal, et le module « Bons de commande » (§118.149
 * — « même chose pour les financiers dans les finances » ; module à part depuis §118.176). Ils calculaient chacun leurs droits et
 * leur papeterie ; deux calculs de « qui peut émettre un BC » finissent par diverger, et le
 * symptôme serait un bouton qu'une action refuse (§118.5). La règle d'émission est celle de la
 * fabrique et d'Adam (`legalWriteAllowed`), rejouée par le serveur au moment d'émettre : l'écran
 * ne fait que la LIRE pour savoir quoi proposer.
 *
 * `null` : cette personne ne peut rien émettre — aucun bouton, et rien n'est chargé.
 */
export interface CompositionPieces {
  types: TypePieceComposable[];
  societes: { id: string; label: string }[];
  societeParDefaut: string | null;
  letterheads: { id: string; name: string; companyId: string | null; companyLabel: string | null }[];
  peutReglerNumerotation: boolean;
  /** Les pièces amont que le menu « Fait suite à » propose (lot D1c — F1) — par la porte de la liste Legal. */
  amont: AmontComposable;
}

const NATURES: readonly (readonly ["INVOICE" | "PURCHASE_ORDER" | "QUOTE", TypePieceComposable])[] = [
  ["INVOICE", "FACTURE"], ["PURCHASE_ORDER", "BON_DE_COMMANDE"], ["QUOTE", "DEVIS"],
];

/**
 * OÙ SE COMPOSE QUOI (décision du Super Admin, 24/11/2026) : la FACTURE se compose dans Comptabilité › Recettes ; Legal
 * garde les bons de commande et les devis. Le DROIT d'émettre ne change pas (`legalWriteAllowed`) — seul l'endroit du
 * bouton : chaque écran demande les types qu'il porte.
 */
export const TYPES_COMPOSES_DANS_LEGAL: readonly TypePieceComposable[] = ["BON_DE_COMMANDE", "DEVIS"];
export const TYPES_COMPOSES_EN_COMPTABILITE: readonly TypePieceComposable[] = ["FACTURE"];

export async function compositionDesPieces(user: CurrentUser, seulement?: readonly TypePieceComposable[]): Promise<CompositionPieces | null> {
  const droits = { onLegal: userCan(user, "LEGAL", "CREATE"), onFinances: userCan(user, "FINANCES", "CREATE") };
  const types = NATURES.filter(([kind]) => legalWriteAllowed({ ...droits, kind })).map(([, type]) => type)
    .filter((t) => !seulement || seulement.includes(t));
  if (types.length === 0) return null;
  // Les natures que l'on peut SUIVRE avec ce qu'on a le droit d'émettre : un devis ne suit rien, un BC suit un
  // devis, une facture suit un devis ou un BC — la table de la fabrique (`NATURES_AMONT`), pas une recopie.
  const naturesAmont = [...new Set(types.flatMap((t) => NATURES_AMONT[t]))];
  const [societes, ctx, societeParDefaut, amont] = await Promise.all([
    getMyCompanies(user.id), letterheadContextFor(user.id), companyIdForNew(user.id), piecesAmontComposables(user, naturesAmont),
  ]);
  return {
    types,
    societes: societes.map((c) => ({ id: c.id, label: companyLabel(c) })),
    societeParDefaut,
    letterheads: ctx.letterheads.filter((l) => l.kind === "word").map((l) => ({ id: l.id, name: l.name, companyId: l.companyId, companyLabel: l.companyLabel })),
    peutReglerNumerotation: canManageLetterheads(user),
    amont,
  };
}
