/**
 * DEMANDES ADMINISTRATIVES — ce que « Terminer » exige, une fois la facture trouvée : l'imputation aux moyens
 * généraux d'un achat.
 *
 * Sorti de `actions/admin-request-actions.ts` (lot V4). L'action garde sa porte, la facture (lue à son point
 * d'appel), la prise conditionnelle de la demande et l'écriture de l'imputation ; elle passe le FORMULAIRE à ce
 * corps. Pour le contrat des actions, ce corps est celui du fichier d'actions (`contrat/internes.ts`) : ses champs
 * et ses écrivains importés comptent pour elle.
 */
import { prisma } from "@/lib/prisma";
import { fdStr, fdNum, type ActionResult } from "@/lib/actions/types";
import { REFUS_SANS_IMPUTATION } from "@/lib/actions/internes/admin-request/traitement";

/** L'arrêt de l'action, avec ce qu'elle rend — un type nommé, pour que `"fini" in …` le distingue de la suite. */
const arret = (r: ActionResult): { fini: ActionResult } => ({ fini: r });

/**
 * `finishRequest`, une fois la facture trouvée : l'imputation lue et vérifiée. `fini` : l'action s'arrête là ;
 * sinon `imputation` dit s'il faut débiter un département, et de combien.
 */
export async function lireLImputation(
  formData: FormData,
  ctx: { id: string; req: { type: string }; fromAdPro: boolean },
) {
  const { id, req, fromAdPro } = ctx;
  // IMPUTATION AUX MOYENS GÉNÉRAUX — le geste qui manquait entre « la demande est faite » et
  // « le budget le sait ».
  //
  // Terminer un achat sans dire QUI le paie laissait le budget des moyens généraux intact
  // pendant que l'argent, lui, était sorti. L'assistante choisit donc le département à
  // débiter : le sien, ou celui qui a demandé — chaque département a SES moyens généraux, et
  // c'est le demandeur qui les consomme, pas le secrétariat qui exécute.
  //
  // EXCEPTION : ce qui vient d'Ad & Pro est déjà porté par le budget de l'opération (poste,
  // ordre de dépense). L'imputer une seconde fois le compterait deux fois.
  //
  // La liste était écrite À LA MAIN ici — cinq natures — pendant que la page de la même demande
  // en lisait huit : sur un achat lié à un POSTE, l'écran masquait l'imputation et cette action
  // l'exigeait, donc la demande ne pouvait plus être terminée (§118.150). Une seule fonction, lue par l'action
  // (`fromAdPro`).
  const departmentId = fdStr(formData, "budgetDepartmentId");
  const amount = fdNum(formData, "budgetAmount");
  const alreadyImputed = await prisma.departmentBudgetExpense.count({ where: { adminRequestId: id } });

  if (req.type === "PURCHASE" && !fromAdPro && alreadyImputed === 0 && (!departmentId || !amount)) {
    return arret({ ok: false, error: REFUS_SANS_IMPUTATION });
  }

  const imputer = departmentId != null && amount != null && alreadyImputed === 0;
  if (imputer && amount < 0) return arret({ ok: false, error: "Un montant ne peut pas être négatif." });
  const dept = imputer ? await prisma.department.findUnique({ where: { id: departmentId }, select: { id: true, name: true } }) : null;
  if (imputer && !dept) return arret({ ok: false, error: "Département introuvable." });
  // L'imputation à écrire, quand il y en a une (le département et le montant vérifiés ci-dessus).
  return { imputation: imputer && dept && amount != null ? { dept, amount } : null };
}
