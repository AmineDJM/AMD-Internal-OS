import { errors } from "@/lib/api/errors";
import { canReadEntity, porteeManquante, type EntityDef } from "@/lib/api/registry/entities";

/**
 * L'OBJET EST-IL OUVERT À CET APPEL ? Deux questions, posées dans cet ordre par chaque route d'objet de l'API v1 :
 * le module est-il lisible par l'identité (le RBAC de l'ERP, `canReadEntity`) ; la clé porte-t-elle la portée que
 * l'objet exige (`porteeManquante`, SA-15). Sinon l'erreur de l'API, levée — la route n'a rien d'autre à faire.
 */
export function exigerLectureEntite(
  ctx: { user: Parameters<typeof canReadEntity>[0]; client: { scopes: readonly string[] } },
  def: EntityDef,
): void {
  if (!canReadEntity(ctx.user, def)) throw errors.forbidden(`Le module ${def.module} n'est pas accessible à cette identité.`);
  const manque = porteeManquante(def, ctx.client.scopes);
  if (manque) throw errors.missingScope([manque], ctx.client.scopes);
}
