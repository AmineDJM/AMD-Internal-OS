import { prisma } from "@/lib/prisma";
import { businessUnitDuDemandeur } from "../business-unit-auto";
import { AVAILABLE_PRODUCT_STATUSES } from "../../domaine/pickers";
import { platformScope, getMyCompanies, companyOptions } from "@/lib/company";
import { toNumber } from "@/lib/utils";
import { userCan, scopeCongressIntl, scopeCongressNational, scopePromoMaterial, scopeSponsoring, scopeAdProOther, type SessionUser } from "@/lib/rbac";
import { adProState, sortAdPro, type AdProKind, type AdProRequest } from "../../domaine/unified";
import { natureDesigneMedecins, natureDesigneMedecinsEtProduits, type AdProCreateData } from "../../domaine/create-fields";
import { optionsDesArticlesDemandes } from "@/lib/queries/promo-achats";
import { etatAdProDuDossier } from "@/lib/promo-material/statut";
import { sansBloquer } from "@/lib/journal";

/**
 * LA LISTE UNIFIÉE DES DEMANDES AD & PRO.
 *
 * Elle relit les cinq modèles et les ramène à une ligne commune. Rien n'est recopié dans une
 * table de synthèse : une copie diverge au premier changement de statut, et l'on se retrouve
 * alors avec deux vérités dont on ne sait plus laquelle croire.
 *
 * LES DROITS SONT CEUX DE CHAQUE NATURE. On n'interroge un modèle que si la personne a le module
 * correspondant — une vue « toutes les demandes » qui contournerait le RBAC serait précisément la
 * fuite que le cloisonnement cherche à empêcher. Quelqu'un qui n'a que le Sponsoring voit une
 * liste unifiée… de sponsorings, et c'est correct.
 */

const LIMIT = 200;

export async function getAdProRequests(user: SessionUser): Promise<AdProRequest[]> {
  const scope = await platformScope(user.id);
  const can = (m: Parameters<typeof userCan>[1]) => userCan(user, m, "VIEW");

  const [sponsorings, intl, national, events, promo, consulting, other] = await Promise.all([
    can("SPONSORING")
      ? prisma.sponsoringRequest.findMany({
          where: { AND: [scope, scopeSponsoring(user)] }, orderBy: { createdAt: "desc" }, take: LIMIT,
          select: {
            id: true, reference: true, institution: true, doctor: true, type: true,
            status: true, createdAt: true, amountRequested: true, requesterId: true,
          },
        }).catch(sansBloquer("ad-pro.getAdProRequests.sponsoringRequest", []))
      : [],
    can("CONGRESS_INTERNATIONAL")
      ? prisma.congressInternational.findMany({
          where: { AND: [scope, scopeCongressIntl(user)] }, orderBy: { createdAt: "desc" }, take: LIMIT,
          select: { id: true, name: true, status: true, createdAt: true, estimatedBudget: true, requesterId: true },
        }).catch(sansBloquer("ad-pro.getAdProRequests.congressInternational", []))
      : [],
    can("CONGRESS_NATIONAL")
      ? prisma.congressNational.findMany({
          where: { AND: [scope, scopeCongressNational(user)] }, orderBy: { createdAt: "desc" }, take: LIMIT,
          select: { id: true, name: true, status: true, createdAt: true, estimatedBudget: true, requesterId: true },
        }).catch(sansBloquer("ad-pro.getAdProRequests.congressNational", []))
      : [],
    can("EVENTS")
      ? prisma.event.findMany({
          where: scope, orderBy: { createdAt: "desc" }, take: LIMIT,
          select: { id: true, name: true, status: true, createdAt: true, estimatedBudget: true, location: true, requesterId: true },
        }).catch(sansBloquer("ad-pro.getAdProRequests.event", []))
      : [],
    can("PROMO_MATERIAL")
      ? prisma.promoMaterial.findMany({
          // LA PORTÉE DES LIGNES, pas seulement le module (§118.153) : un délégué qui a le
          // matériel promotionnel en « lignes assignées » ne voit que SES dossiers dans l'écran du
          // module — la liste unifiée ne doit pas lui montrer ceux des autres.
          where: { AND: [scope, scopePromoMaterial(user)] }, orderBy: { createdAt: "desc" }, take: LIMIT,
          select: { id: true, reference: true, title: true, status: true, circuitState: true, circuitVersion: true, returnedAt: true, createdAt: true, chosenAmount: true, amount: true, chosenAgency: true, requesterId: true },
        }).catch(sansBloquer("ad-pro.getAdProRequests.promoMaterial", []))
      : [],
    can("CONSULTING")
      ? prisma.consultingContract.findMany({
          // Le pôle Ad & Pro seulement : un contrat passé aux RH n'est plus une demande de
          // promotion, et cette liste ne doit pas le rendre à qui n'a que la promotion (§118.150).
          where: { AND: [scope, { pole: "AD_PRO" }] }, orderBy: { createdAt: "desc" }, take: LIMIT,
          select: { id: true, reference: true, title: true, counterparty: true, status: true, returnedAt: true, createdAt: true, amount: true, requesterId: true },
        }).catch(sansBloquer("ad-pro.getAdProRequests.consultingContract", []))
      : [],
    can("AD_PRO_OTHER")
      ? prisma.adProOtherRequest.findMany({
          where: { AND: [scope, scopeAdProOther(user)] }, orderBy: { createdAt: "desc" }, take: LIMIT,
          select: { id: true, reference: true, title: true, beneficiary: true, status: true, createdAt: true, amount: true, requesterId: true },
        }).catch(sansBloquer("ad-pro.getAdProRequests.adProOtherRequest", []))
      : [],
  ]);

  // Les demandeurs en UN lot : cinq relations séparées feraient cinq fois le même travail, et
  // l'écran n'a besoin que d'un nom.
  const requesterIds = [...new Set([
    ...sponsorings.map((r) => r.requesterId),
    ...intl.map((r) => r.requesterId),
    ...national.map((r) => r.requesterId),
    ...events.map((r) => r.requesterId),
    ...promo.map((r) => r.requesterId),
    ...consulting.map((r) => r.requesterId),
    ...other.map((r) => r.requesterId),
  ].filter((x): x is string => Boolean(x)))];
  const people = requesterIds.length
    ? await prisma.user.findMany({ where: { id: { in: requesterIds } }, select: { id: true, name: true } })
    : [];
  const nameOf = (id: string | null) => (id ? people.find((p) => p.id === id)?.name ?? null : null);

  const rows: AdProRequest[] = [
    ...sponsorings.map((r) => ({
      id: r.id, kind: "SPONSORING" as const, reference: r.reference,
      title: [r.type, r.institution].filter(Boolean).join(" — ") || "Sponsoring",
      beneficiary: r.doctor ?? r.institution,
      amount: r.amountRequested === null ? null : toNumber(r.amountRequested),
      status: r.status, state: adProState(r.status), requester: nameOf(r.requesterId),
      createdAt: r.createdAt.toISOString(), href: `/sponsoring/${r.id}`,
    })),
    ...intl.map((r) => ({
      id: r.id, kind: "CONGRESS_INTERNATIONAL" as const, reference: r.id.slice(-6).toUpperCase(), title: r.name,
      beneficiary: null, amount: r.estimatedBudget === null ? null : toNumber(r.estimatedBudget),
      status: r.status, state: adProState(r.status), requester: nameOf(r.requesterId),
      createdAt: r.createdAt.toISOString(), href: `/congress-international/${r.id}`,
    })),
    ...national.map((r) => ({
      id: r.id, kind: "CONGRESS_NATIONAL" as const, reference: r.id.slice(-6).toUpperCase(), title: r.name,
      beneficiary: null, amount: r.estimatedBudget === null ? null : toNumber(r.estimatedBudget),
      status: r.status, state: adProState(r.status), requester: nameOf(r.requesterId),
      createdAt: r.createdAt.toISOString(), href: `/congress-national/${r.id}`,
    })),
    ...events.map((r) => ({
      id: r.id, kind: "EVENT" as const, reference: r.id.slice(-6).toUpperCase(), title: r.name,
      beneficiary: r.location, amount: r.estimatedBudget === null ? null : toNumber(r.estimatedBudget),
      status: r.status, state: adProState(r.status), requester: nameOf(r.requesterId),
      createdAt: r.createdAt.toISOString(), href: `/events/${r.id}`,
    })),
    ...promo.map((r) => ({
      id: r.id, kind: "PROMO_MATERIAL" as const, reference: r.reference, title: r.title,
      beneficiary: r.chosenAgency,
      // Le montant RETENU fait foi dès qu'un devis est choisi ; sinon le budget estimé.
      amount: r.chosenAmount !== null ? toNumber(r.chosenAmount) : r.amount === null ? null : toNumber(r.amount),
      // UN DOSSIER À CIRCUIT SE JUGE SUR SON ÉTAT (§118.153) : son `status` hérité reste figé à
      // « Prospection demandée » pour toujours, et la liste comptait « en attente de décision »
      // un dossier terminé ou refusé.
      status: r.circuitState ?? r.status, state: etatAdProDuDossier(r), requester: nameOf(r.requesterId),
      createdAt: r.createdAt.toISOString(), href: `/promo-material/${r.id}`,
    })),
    ...consulting.map((r) => ({
      id: r.id, kind: "CONSULTING" as const, reference: r.reference, title: r.title,
      // L'AUTRE PARTIE tient lieu de bénéficiaire : c'est elle qu'on cherche dans la liste
      // quand on se demande avec qui l'on a déjà contracté.
      beneficiary: r.counterparty,
      amount: r.amount === null ? null : toNumber(r.amount),
      // RENVOYÉ POUR CORRECTION (audit 360°, lot C4a) : un brouillon qui porte un renvoi n'est pas un
      // brouillon qu'on n'a pas encore envoyé — c'est son porteur qui a la main, « À corriger » comme
      // les autres natures (§118.186). Rangé « Brouillon », il disparaissait de ce qu'on attend de lui.
      status: r.status, state: r.status === "DRAFT" && r.returnedAt ? "RETURNED" : adProState(r.status), requester: nameOf(r.requesterId),
      createdAt: r.createdAt.toISOString(), href: `/consulting/${r.id}`,
    })),
    ...other.map((r) => ({
      id: r.id, kind: "OTHER" as const, reference: r.reference, title: r.title,
      beneficiary: r.beneficiary,
      amount: r.amount === null ? null : toNumber(r.amount),
      status: r.status, state: adProState(r.status), requester: nameOf(r.requesterId),
      createdAt: r.createdAt.toISOString(), href: `/ad-pro/autres/${r.id}`,
    })),
  ];

  return sortAdPro(rows);
}

/**
 * CE QU'IL FAUT POUR CRÉER, SUR L'ÉCRAN AD & PRO LUI-MÊME.
 *
 * Le formulaire de chaque nature s'ouvre désormais dans le panneau commun. Ses listes (médecins
 * invitables, collaborateurs, chefs de produit, entités) ne peuvent donc plus venir de l'écran de
 * la nature : elles se lisent ici.
 *
 * ON NE LIT QUE CE QUI SERA UTILISÉ. Les natures créables sont connues avant l'appel : quelqu'un
 * qui ne peut créer qu'un sponsoring ne déclenche ni la liste des médecins ni celle des entités.
 * Une page qui interroge cinq tables pour un panneau que personne n'ouvrira, c'est du temps
 * d'affichage payé par tout le monde au bénéfice de personne.
 */
export async function getAdProCreateData(userId: string, kinds: readonly AdProKind[]): Promise<AdProCreateData> {
  const has = (k: AdProKind) => kinds.includes(k);
  /*
   * CE QU'ON CHARGE SE LIT SUR LE REGISTRE, PAS SUR UNE LISTE DE NATURES ÉCRITE ICI.
   *
   * La version d'avant s'écrivait `has("CONGRESS_INTERNATIONAL") || has("CONGRESS_NATIONAL") ||
   * has("SPONSORING")`, et le prix était MESURÉ : `getAdProCreateData(id, ["EVENT"])` rendait
   * **0 médecin, 0 produit, 0 spécialité** — donc, sur l'écran Events et sur la fiche d'un
   * événement, les trois menus que la Direction venait d'exiger retombaient en SAISIE LIBRE, en
   * silence, alors qu'ils fonctionnaient depuis le panneau d'Ad & Pro (qui, lui, passe aussi
   * SPONSORING). Une porte gardée à côté d'une porte ouverte, et c'est la même chose qui passe
   * (§118.71, §118.108) — le défaut exact que le lot précédent avait laissé derrière lui.
   *
   * On interroge donc la décision canonique (`REFERENTIELS_PAR_NATURE`) : une nature ajoutée
   * demain y déclare son cas, et son chargement suit sans que personne y pense (§118.130).
   *
   * LES PRODUITS PROMOUVABLES restent ceux dont le traitement réglementaire est TERMINÉ :
   * proposer un dossier en cours ferait préparer la promotion d'un médicament qui n'a pas encore
   * le droit d'être promu — ce n'est pas une maladresse d'écran, c'est une faute réglementaire.
   */
  const needsReferentiels = kinds.some((k) => natureDesigneMedecinsEtProduits(k));
  // Les PRISES EN CHARGE proposent des praticiens sans produit (04/10/2026) : le médecin et le
  // produit ne se chargent plus ensemble.
  const needsDoctors = kinds.some((k) => natureDesigneMedecins(k));
  const needsProducts = needsReferentiels;
  const needsPeople = kinds.length > 0;

  // LE RÉFÉRENTIEL DES SPÉCIALITÉS — la Direction demande un menu déroulant, et sa liste ne
  // s'écrit pas à la main : `MedicalSpecialty` est le référentiel canonique du produit, et une
  // liste recopiée ici serait fausse le jour où la Promotion médicale en ajoute une (§118.73).
  //
  // La spécialité suit les MÉDECINS et non les produits : elle sert à classer un praticien, et
  // c'est aussi elle qui FILTRE la liste des médecins sur le formulaire des prises en charge.
  const needsSpecialties = needsReferentiels;

  const [doctors, users, companies, products, businessUnits, specialties, demandeur, catalogueMateriel] = await Promise.all([
    needsDoctors
      ? prisma.medicalDoctor.findMany({
          select: { id: true, name: true, specialty: true, city: true },
          orderBy: [{ specialty: "asc" }, { name: "asc" }],
        })
      : Promise.resolve([] as { id: string; name: string; specialty: string | null; city: string | null }[]),
    needsPeople
      ? prisma.user.findMany({ where: { isActive: true }, select: { id: true, name: true, role: true }, orderBy: { name: "asc" } })
      : Promise.resolve([] as { id: string; name: string; role: string }[]),
    // Le MATÉRIEL PROMOTIONNEL ne propose plus d'entité : c'est celle où le demandeur travaille,
    // déduite au serveur (décision du 01/10, §118.171).
    has("CONSULTING") || has("OTHER")
      // Les entités PROPOSÉES sont celles de la personne : sans quoi le formulaire laisserait
      // rattacher une demande à une société qu'elle n'a pas le droit de voir.
      ? getMyCompanies(userId).then(companyOptions)
      : Promise.resolve([] as { value: string; label: string }[]),
    needsProducts
      ? prisma.regulatoryProduct.findMany({
          where: { status: { in: AVAILABLE_PRODUCT_STATUSES as never } },
          select: { id: true, brandName: true, dci: true, status: true },
          orderBy: [{ brandName: "asc" }, { dci: "asc" }],
        })
      : Promise.resolve([] as { id: string; brandName: string | null; dci: string; status: string }[]),
      // LES GAMMES ACTIVES — c'est le budget Ad&Pro de l'une d'elles que la demande engage.
    // Toujours chargées : les cinq natures de demande Ad&Pro se rattachent toutes à une gamme.
    prisma.businessUnit.findMany({
      where: { isActive: true },
      select: { id: true, name: true },
      orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    }),
    needsSpecialties
      ? prisma.medicalSpecialty.findMany({ select: { name: true }, orderBy: { name: "asc" } })
      : Promise.resolve([] as { name: string }[]),
    // LE DEMANDEUR, pour déduire sa gamme. Chargé ici et non passé en argument : les appelants
    // n'ont qu'un identifiant, et leur faire porter le rôle multiplierait les endroits où le
    // rattachement se lit — donc les endroits où il finirait par se lire autrement (§118.5).
    prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, secondaryRole: true } }),
    // LE MATÉRIEL PROMOTIONNEL SE DEMANDE EN LIGNES (§118.171) : le catalogue actif et les
    // produits, le même chargement que la fiche. L'assistante qui retranscrit les devis ne se
    // choisit plus à la création — tout le secrétariat est prévenu quand les devis sont demandés.
    has("PROMO_MATERIAL")
      ? optionsDesArticlesDemandes()
      : Promise.resolve({ catalogue: [], produits: [] } as Awaited<ReturnType<typeof optionsDesArticlesDemandes>>),
]);

  const businessUnitDeduite = demandeur ? await businessUnitDuDemandeur(demandeur) : null;

  return {
    doctors: doctors.map((d) => ({ id: d.id, name: d.name, specialty: d.specialty ?? "Sans spécialité", city: d.city ?? "" })),
    users: users.map((u) => ({ id: u.id, name: u.name, role: u.role })),
    catalogueMateriel,
    specialties,
    // Les libellés HÉRITÉS des fiches non rattachées : une spécialité portée par quarante
    // médecins et absente du référentiel doit rester choisissable, sinon une demande légitime
    // est refusée pour une ligne de table manquante.
    specialtiesHeritees: doctors.map((d) => d.specialty).filter((x): x is string => Boolean(x && x.trim())),
    businessUnitDeduite,
    companies,
    products: products.map((p) => ({ id: p.id, brandName: p.brandName, dci: p.dci, status: String(p.status) })),
    businessUnits,
  };
}
