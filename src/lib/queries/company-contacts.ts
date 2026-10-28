import { et } from "@/lib/acces/compose";
import { prisma } from "@/lib/prisma";
import { companyScopedWhere } from "@/lib/company";
import type { PartyOption } from "@/lib/contacts/parties";

/**
 * LES PARTIES DISPONIBLES — l'annuaire de l'entreprise, vu depuis Legal et depuis Courriers.
 *
 * Une seule requête, un seul cloisonnement (`companyScopedWhere`) : les écrans qui désignent une
 * partie ne doivent pas réinventer leur propre lecture de l'annuaire, sinon deux d'entre eux
 * finiront par ne pas montrer les mêmes contacts.
 *
 * Les contacts INACTIFS sont écartés des choix NOUVEAUX — mais ils restent lisibles sur les
 * pièces qui les portent déjà : une partie à un contrat signé en 2023 ne disparaît pas du contrat
 * parce qu'on ne travaille plus avec elle.
 */
export async function listPartyOptions(userId: string, opts: { includeIds?: string[] } = {}): Promise<PartyOption[]> {
  const scope = await companyScopedWhere(userId, {});
  const garder = opts.includeIds?.filter(Boolean) ?? [];
  const rows = await prisma.companyContact.findMany({
    where: garder.length > 0
      ? { OR: [et(scope, { isActive: true }), { id: { in: garder } }] }
      : et(scope, { isActive: true }),
    orderBy: [{ name: "asc" }],
    select: {
      id: true, name: true, kind: true, contactName: true, email: true,
      phone: true, phoneAlt: true, city: true,
      company: { select: { name: true, shortName: true } },
    },
  });
  return rows.map((c) => ({
    id: c.id, name: c.name, kind: c.kind, contactName: c.contactName,
    email: c.email, phone: c.phone, phoneAlt: c.phoneAlt, city: c.city,
    companyLabel: c.company ? c.company.shortName ?? c.company.name : null,
  }));
}

/**
 * CE QUE LE FORMULAIRE A CHOISI, VÉRIFIÉ.
 *
 * Les identifiants viennent de champs cachés : sans contrôle, on rattacherait une pièce à un
 * contact d'une AUTRE entité du groupe, ou à un contact effacé depuis. On revérifie donc le
 * cloisonnement (`companyScopedWhere`) comme partout ailleurs — un sélecteur n'est pas une
 * autorisation — et l'on renvoie le TEXTE à écrire dans la colonne d'affichage.
 *
 * L'ordre choisi est conservé : « nous et eux » n'est pas « eux et nous ».
 */
export async function resolveParties(
  userId: string,
  ids: readonly string[],
): Promise<{ ok: true; ids: string[]; text: string } | { ok: false; error: string }> {
  const demandes = [...new Set(ids.map((x) => String(x)).filter(Boolean))];
  if (demandes.length === 0) return { ok: true, ids: [], text: "" };
  const scope = await companyScopedWhere(userId, {});
  const rows = await prisma.companyContact.findMany({
    where: et(scope, { id: { in: demandes } }),
    select: { id: true, name: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r.name]));
  const manquants = demandes.filter((id) => !byId.has(id));
  if (manquants.length > 0) {
    return {
      ok: false,
      error: `${manquants.length} contact(s) choisi(s) n'existent plus dans l'annuaire, ou ne sont pas dans votre périmètre. Rechoisissez-les.`,
    };
  }
  const gardes = demandes.filter((id) => byId.has(id));
  return { ok: true, ids: gardes, text: gardes.map((id) => byId.get(id) as string).join(", ") };
}

/**
 * RETROUVER UNE PARTIE PAR SON NOM — pour les appelants qui n'ont qu'un nom, comme Adam.
 *
 * Un modèle propose un nom ; il ne peut pas inventer un identifiant d'annuaire, et c'est très
 * bien ainsi. Mais accepter le nom tel quel remettrait le texte libre en place par une porte
 * dérobée. On ne rend donc un contact que s'il est TROUVÉ **sans ambiguïté** : zéro résultat ou
 * plusieurs, on refuse en le disant. Rattacher un contrat au mauvais fournisseur en annonçant que
 * c'est fait coûte plus cher que de ne rien rattacher.
 */
export async function findPartyByName(
  userId: string,
  name: string,
): Promise<{ ok: true; id: string; name: string } | { ok: false; error: string }> {
  const q = name.trim();
  if (!q) return { ok: false, error: "Aucun nom de partie fourni." };
  const scope = await companyScopedWhere(userId, {});
  const rows = await prisma.companyContact.findMany({
    where: et(scope, { isActive: true, name: { equals: q, mode: "insensitive" } }),
    select: { id: true, name: true },
    take: 5,
  });
  if (rows.length === 1) return { ok: true, id: rows[0].id, name: rows[0].name };
  if (rows.length === 0) {
    const proches = await prisma.companyContact.findMany({
      where: et(scope, { isActive: true, name: { contains: q, mode: "insensitive" } }),
      select: { id: true, name: true },
      take: 5,
    });
    if (proches.length === 1) return { ok: true, id: proches[0].id, name: proches[0].name };
    if (proches.length === 0) {
      return { ok: false, error: `« ${q} » ne figure pas dans l'annuaire de l'entreprise. Ajoutez-le à l'annuaire, puis recommencez.` };
    }
    return { ok: false, error: `« ${q} » correspond à ${proches.length} contacts de l'annuaire (${proches.map((p) => p.name).join(", ")}). Précisez lequel.` };
  }
  return { ok: false, error: `« ${q} » correspond à ${rows.length} contacts de l'annuaire. Précisez lequel.` };
}
