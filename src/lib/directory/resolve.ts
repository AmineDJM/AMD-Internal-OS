import { DirectoryChannel, EndpointConfidence } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { normalizeName, rankEndpoints, type ResolvedEndpoint, type PersonMatch } from "./rank";
import { sansBloquer } from "@/lib/journal";

/**
 * RETROUVER UNE PERSONNE, ET SON ADRESSE — dans l'ordre où l'entreprise fait autorité.
 *
 * LE DÉFAUT QUE CE MODULE CORRIGE. « Envoie un mail à Raihana » recevait « je n'ai pas son
 * adresse » alors que l'ERP la connaissait. La résolution ne regardait qu'une seule colonne
 * (`User.email`, retrouvée par `name contains`), et n'avait aucune idée de ce qu'elle valait :
 * pas de variantes, pas d'alias, pas de provenance. Une personne qui a une adresse Pharmagene et
 * une Gmail n'entrait tout simplement pas dans le modèle.
 *
 * L'ORDRE DES SOURCES N'EST PAS UN DÉTAIL — c'est la règle métier elle-même :
 *
 *   1. **L'ANNUAIRE INTERNE** (`DirectoryEntry`) — ce que l'entreprise a saisi et vérifié.
 *   2. **LES FICHES ERP** (`User`, `Employee`) — vrai, mais une seule adresse et sans nuance.
 *   3. **LES CONTACTS D'ENTREPRISE** (`CompanyContact`) — les externes déjà référencés.
 *   4. **L'HISTORIQUE DE CORRESPONDANCE** (`EmailRecord`) — plausible, jamais autorité.
 *
 * Google n'est PAS le carnet d'adresses de l'entreprise : ce qu'on a vu passer dans une boîte est
 * un indice, pas un référentiel. Il vient donc après tout ce que l'entreprise maintient.
 *
 * Ce fichier fait les REQUÊTES ; le classement est pur et vit dans `rank.ts` — c'est lui qui se
 * teste sans base, et c'est là qu'est la logique délicate.
 */

export type { PersonMatch } from "./rank";

const CONFIDENCE_OF_SOURCE: Record<string, EndpointConfidence> = {
  directory: EndpointConfidence.VERIFIED_INTERNAL,
  erp: EndpointConfidence.VERIFIED_PROVIDER,
  contact: EndpointConfidence.VERIFIED_PROVIDER,
  history: EndpointConfidence.OBSERVED_HISTORY,
};

/** Une recherche vide ne doit jamais ramener « tout le monde » : on refuse plutôt. */
const usable = (q: string): boolean => normalizeName(q).length >= 2;

/**
 * TOUTES les personnes qui répondent à ce nom, avec leurs moyens de contact classés.
 *
 * Rend une LISTE, pas un choix : décider à la place du PDG lequel des deux Amine recevra le
 * message n'est pas de la fluidité, c'est un risque. L'appelant tranche — ou pose UNE question.
 */
export async function findPeople(query: string, limit = 5): Promise<PersonMatch[]> {
  if (!usable(query)) return [];
  const q = query.trim();
  const byKey = new Map<string, PersonMatch>();

  const push = (key: string, base: Omit<PersonMatch, "endpoints">, endpoints: ResolvedEndpoint[]) => {
    const existing = byKey.get(key);
    if (existing) {
      existing.endpoints.push(...endpoints);
      // La fiche RH COMPLÈTE le compte ERP trouvé avant elle (poste, entité, N+1, département) — sans rien écraser.
      for (const k of ["jobTitle", "company", "employeeId", "manager", "department"] as const) if (existing[k] == null && base[k] != null) existing[k] = base[k] as never;
      return;
    }
    byKey.set(key, { ...base, endpoints: [...endpoints] });
  };

  // ── 1. L'ANNUAIRE INTERNE — nom affiché OU alias. C'est ici que vivent « Amine », « AD »… ──
  const entries = await prisma.directoryEntry.findMany({
    where: {
      isActive: true,
      OR: [{ displayName: { contains: q, mode: "insensitive" } }, { aliases: { has: q.toLowerCase() } }],
    },
    take: limit * 2,
    include: {
      endpoints: { where: { isActive: true } },
      user: { select: { id: true, name: true, email: true, title: true } },
      employee: { select: { id: true, fullName: true, position: true, email: true, phone: true } },
      contact: { select: { id: true, name: true, email: true, phone: true } },
      company: { select: { shortName: true, name: true } },
    },
  }).catch(sansBloquer("resolve.findPeople.directoryEntry", []));

  for (const e of entries) {
    const key = e.userId ?? e.employeeId ?? e.contactId ?? e.id;
    push(key, {
      key,
      name: e.user?.name ?? e.employee?.fullName ?? e.contact?.name ?? e.displayName,
      jobTitle: e.jobTitle ?? e.user?.title ?? e.employee?.position ?? null,
      company: e.company?.shortName ?? e.company?.name ?? null,
      userId: e.userId, employeeId: e.employeeId, contactId: e.contactId,
      directoryEntryId: e.id,
    }, e.endpoints.map((p) => ({
      channel: p.channel, value: p.value, label: p.label,
      confidence: p.confidence, isPrimary: p.isPrimary, source: p.source ?? "annuaire interne",
    })));
  }

  // ── 2. LES FICHES ERP — la vérité métier, même sans entrée d'annuaire ──
  const [users, employees] = await Promise.all([
    prisma.user.findMany({
      where: { isActive: true, name: { contains: q, mode: "insensitive" } },
      take: limit * 2,
      select: { id: true, name: true, email: true, title: true, phone: true },
    }).catch(sansBloquer("resolve.findPeople.user", [])),
    prisma.employee.findMany({
      where: { isActive: true, fullName: { contains: q, mode: "insensitive" } },
      take: limit * 2,
      select: {
        id: true, fullName: true, position: true, email: true, phone: true, userId: true, company: { select: { shortName: true, name: true } },
        manager: { select: { fullName: true } }, departmentRef: { select: { name: true } },
      },
    }).catch(sansBloquer("resolve.findPeople.employee", [])),
  ]);

  for (const u of users) {
    const endpoints: ResolvedEndpoint[] = [
      { channel: DirectoryChannel.EMAIL, value: u.email.toLowerCase(), label: "compte ERP", confidence: CONFIDENCE_OF_SOURCE.erp, isPrimary: false, source: "compte ERP" },
    ];
    if (u.phone) endpoints.push({ channel: DirectoryChannel.PHONE, value: u.phone, label: "compte ERP", confidence: CONFIDENCE_OF_SOURCE.erp, isPrimary: false, source: "compte ERP" });
    push(u.id, { key: u.id, name: u.name, jobTitle: u.title, company: null, userId: u.id, employeeId: null, contactId: null, directoryEntryId: null }, endpoints);
  }

  for (const e of employees) {
    const key = e.userId ?? e.id;
    const endpoints: ResolvedEndpoint[] = [];
    if (e.email) endpoints.push({ channel: DirectoryChannel.EMAIL, value: e.email.toLowerCase(), label: "fiche RH", confidence: CONFIDENCE_OF_SOURCE.erp, isPrimary: false, source: "fiche RH" });
    if (e.phone) endpoints.push({ channel: DirectoryChannel.PHONE, value: e.phone, label: "fiche RH", confidence: CONFIDENCE_OF_SOURCE.erp, isPrimary: false, source: "fiche RH" });
    push(key, {
      key, name: e.fullName, jobTitle: e.position,
      company: e.company?.shortName ?? e.company?.name ?? null,
      userId: e.userId, employeeId: e.id, contactId: null, directoryEntryId: null,
      manager: e.manager?.fullName ?? null, department: e.departmentRef?.name ?? null,
    }, endpoints);
  }

  // ── 3. LES CONTACTS D'ENTREPRISE — agences, fournisseurs, prestataires ──
  const contacts = await prisma.companyContact.findMany({
    where: {
      isActive: true,
      OR: [{ name: { contains: q, mode: "insensitive" } }, { contactName: { contains: q, mode: "insensitive" } }],
    },
    take: limit,
    select: { id: true, name: true, contactName: true, email: true, phone: true, kind: true },
  }).catch(sansBloquer("resolve.findPeople.companyContact", []));

  for (const c of contacts) {
    const endpoints: ResolvedEndpoint[] = [];
    if (c.email) endpoints.push({ channel: DirectoryChannel.EMAIL, value: c.email.toLowerCase(), label: "contact société", confidence: CONFIDENCE_OF_SOURCE.contact, isPrimary: false, source: "annuaire des contacts" });
    if (c.phone) endpoints.push({ channel: DirectoryChannel.PHONE, value: c.phone, label: "contact société", confidence: CONFIDENCE_OF_SOURCE.contact, isPrimary: false, source: "annuaire des contacts" });
    push(c.id, {
      key: c.id, name: c.contactName ? `${c.contactName} (${c.name})` : c.name,
      jobTitle: c.kind, company: null, userId: null, employeeId: null, contactId: c.id, directoryEntryId: null,
    }, endpoints);
  }

  // ── 4. L'HISTORIQUE — en DERNIER, et jamais promu au rang de référentiel ──
  if (byKey.size === 0) {
    const seen = await prisma.emailRecord.findMany({
      where: { direction: "INBOUND", fromName: { contains: q, mode: "insensitive" } },
      orderBy: { sentAt: "desc" }, take: limit,
      select: { fromAddress: true, fromName: true, sentAt: true },
    }).catch(sansBloquer("resolve.findPeople.emailRecord", []));
    const uniques = new Map<string, { name: string | null; at: Date | null }>();
    for (const m of seen) if (!uniques.has(m.fromAddress)) uniques.set(m.fromAddress, { name: m.fromName, at: m.sentAt });
    for (const [address, meta] of uniques) {
      push(address, {
        key: address, name: meta.name ?? address, jobTitle: null, company: null,
        userId: null, employeeId: null, contactId: null, directoryEntryId: null,
      }, [{
        channel: DirectoryChannel.EMAIL, value: address.toLowerCase(), label: "vu en correspondance",
        confidence: CONFIDENCE_OF_SOURCE.history, isPrimary: false, source: "historique des messages",
      }]);
    }
  }

  return [...byKey.values()]
    .map((p) => ({ ...p, endpoints: rankEndpoints(p.endpoints) }))
    .slice(0, limit);
}
