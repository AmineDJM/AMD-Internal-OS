/**
 * FORCE DE VENTE — les SECTEURS lus avant d'être écrits : libérer le nom qu'un secteur retiré occupe, vérifier en
 * base les établissements, les KAM, l'homonyme et la couverture des services d'un secteur qu'on enregistre ; le nom par
 * défaut d'un territoire de KAM ; ses secteurs quand il change de BU ; et les refus qui nomment le remède.
 *
 * Sorti de `actions/sales-planning-actions.ts` (lot V4). L'ÉCRITURE du secteur (transaction, audit) reste dans le
 * corps commun du fichier d'actions (`ecrireSecteur`), qui lit aussi le formulaire.
 */
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { lireCouverture } from "@/lib/annuaires/services";
import { nomDuTerritoire } from "@/lib/sfe/territoire-kam";

/** La longueur d'un nom de secteur : il s'affiche dans une cellule de tableau et sur une carte. */
export const NOM_SECTEUR_MAX = 80;

/**
 * UN NOM QUE SEUL UN SECTEUR RETIRÉ OCCUPE EST LIBRE (Direction, 08/10 : « ça me dit qu'un territoire Centre existe déjà,
 * alors que ce n'est pas vrai »). Les secteurs PARTAGÉS d'avant (« Centre », « Est »…) ont été repris dans les territoires
 * des KAM puis DÉSACTIVÉS, jamais supprimés (migration `20270106093000_territoire_kam`) : invisibles partout, ils gardaient
 * leur nom et la contrainte d'unicité `(businessUnitId, name)` refusait ce nom au territoire qui le voulait. On renomme
 * l'ancien en « Centre (ancien) » — son historique reste entier — et le nom revient à qui le choisit. Un secteur ACTIF du
 * même nom, lui, reste un vrai homonyme : le refus qui suit le nomme.
 */
export async function libererNomRetire(businessUnitId: string, nom: string, saufId: string | null): Promise<void> {
  const retires = await prisma.salesSector.findMany({
    where: { businessUnitId, isActive: false, name: { equals: nom, mode: "insensitive" }, ...(saufId ? { id: { not: saufId } } : {}) },
    select: { id: true, name: true },
  });
  for (const r of retires) {
    for (let n = 1; n < 50; n++) {
      const candidat = `${r.name} (ancien${n > 1 ? ` ${n}` : ""})`.slice(0, NOM_SECTEUR_MAX);
      const pris = await prisma.salesSector.findFirst({
        where: { businessUnitId, name: { equals: candidat, mode: "insensitive" } },
        select: { id: true },
      });
      if (pris) continue;
      await prisma.salesSector.update({ where: { id: r.id }, data: { name: candidat } });
      break;
    }
  }
}

/**
 * LA VÉRIFICATION D'UN SECTEUR AVANT SON ÉCRITURE — le nom libéré s'il n'est tenu que par un secteur retiré, puis les
 * identifiants vérifiés en base, l'homonyme, et la couverture des services lue du formulaire (`couverture`, sa valeur
 * brute). Rend le refus tel qu'il se dit, ou les établissements restreints à certains services (`null` = le formulaire
 * n'en dit rien).
 */
export async function verifierSecteur(
  businessUnitId: string, sectorId: string | null, name: string, institutionIds: string[], repIds: string[],
  couverture: FormDataEntryValue | null,
): Promise<{ ok: true; restreints: Map<string, string[]> | null } | { ok: false; error: string }> {
  await libererNomRetire(businessUnitId, name, sectorId);
  const [institutions, reps, homonyme, dejaCouverts] = await Promise.all([
    institutionIds.length
      ? prisma.medicalInstitution.findMany({ where: { id: { in: institutionIds } }, select: { id: true, name: true, isActive: true } })
      : Promise.resolve([] as { id: string; name: string; isActive: boolean }[]),
    // UN KAM DE CETTE BU (§118.184 — S15) : l'écran ne propose que les KAM rattachés à la BU ; une requête
    // forgée y affectait n'importe quel compte, qui recevait alors un territoire d'une autre équipe.
    repIds.length
      ? prisma.salesRepProfile.findMany({ where: { repId: { in: repIds }, businessUnitId }, select: { repId: true } })
      : Promise.resolve([] as { repId: string }[]),
    // UN SEUL SECTEUR « Est » PAR BU. La contrainte d'unicité le tient déjà ; on la lit d'abord
    // pour rendre une phrase plutôt qu'un code Prisma.
    prisma.salesSector.findFirst({
      where: { businessUnitId, name: { equals: name, mode: "insensitive" }, ...(sectorId ? { id: { not: sectorId } } : {}) },
      select: { id: true },
    }),
    // CE QUE LE SECTEUR COUVRE DÉJÀ : un établissement désactivé depuis y reste (le retirer en silence
    // à l'enregistrement retirerait des médecins du panel sans que personne l'ait décidé).
    sectorId
      ? prisma.salesSectorInstitution.findMany({ where: { sectorId }, select: { institutionId: true } })
      : Promise.resolve([] as { institutionId: string }[]),
  ]);
  if (institutions.length !== institutionIds.length) {
    return { ok: false, error: `${institutionIds.length - institutions.length} établissement(s) sélectionné(s) n'existent plus dans l'annuaire — rechargez l'écran.` };
  }
  // UN ÉTABLISSEMENT DÉSACTIVÉ NE S'AJOUTE PLUS — l'écran ne le propose pas ; une requête forgée,
  // si. Il RESTE quand le secteur le couvrait déjà (§118.172).
  const couvertsAvant = new Set(dejaCouverts.map((d) => d.institutionId));
  const inactifsAjoutes = institutions.filter((i) => !i.isActive && !couvertsAvant.has(i.id));
  if (inactifsAjoutes.length > 0) {
    const noms = inactifsAjoutes.map((i) => `« ${i.name} »`).join(", ");
    return { ok: false, error: `${noms} : désactivé dans l'annuaire, on ne l'ajoute pas à un territoire. Réactivez-le d'abord dans Annuaires › Établissements.` };
  }
  if (reps.length !== repIds.length) {
    return { ok: false, error: `${repIds.length - reps.length} KAM sélectionné(s) ne sont pas (ou plus) rattachés à cette BU — rattachez-les d'abord à la BU, ou rechargez l'écran.` };
  }
  if (homonyme) return { ok: false, error: `Un secteur « ${name} » existe déjà dans cette BU.` };

  // CE QUE LE SECTEUR COUVRE DE CHAQUE ÉTABLISSEMENT (§118.172) — tous ses services, ou certains.
  // `null` = le formulaire n'en dit rien (une op d'Adam, un appel qui ne touche qu'au nom) : chaque
  // établissement DÉJÀ couvert garde sa couverture, un nouveau les prend tous. Un champ absent ne
  // doit pas élargir en silence un territoire qu'on avait restreint (§118.152c).
  const couv = lireCouverture(couverture);
  if (!couv.ok) return { ok: false, error: couv.error };
  const restreints = couv.parEtablissement
    ? new Map([...couv.parEtablissement].filter(([id]) => institutionIds.includes(id)))
    : null;
  if (restreints && restreints.size > 0) {
    // « AUCUN SERVICE » n'est pas un choix qu'on fait exprès : c'est « tous » qu'on a oublié de
    // cocher, ou un établissement qu'on voulait retirer. On le dit plutôt que de deviner.
    const vides = [...restreints].filter(([, ids]) => ids.length === 0).map(([id]) => id);
    if (vides.length > 0) {
      const noms = await prisma.medicalInstitution.findMany({ where: { id: { in: vides } }, select: { name: true } });
      return { ok: false, error: `Aucun service choisi pour ${noms.map((n) => `« ${n.name} »`).join(", ")} : cochez au moins un service, ou « Tous les services ».` };
    }
    // UN SERVICE N'EXISTE QUE DANS SON ÉTABLISSEMENT — un écran ignore ce qu'une requête forgée
    // envoie, c'est ici que la règle se tient.
    const demandes = [...restreints].flatMap(([institutionId, ids]) => ids.map((serviceId) => ({ institutionId, serviceId })));
    const connus = await prisma.medicalInstitutionService.findMany({
      where: { id: { in: [...new Set(demandes.map((d) => d.serviceId))] } },
      select: { id: true, institutionId: true },
    });
    const deQui = new Map(connus.map((c) => [c.id, c.institutionId]));
    if (demandes.some((d) => deQui.get(d.serviceId) !== d.institutionId)) {
      return { ok: false, error: "Un service choisi n'existe plus, ou n'appartient pas à son établissement — rechargez l'écran." };
    }
  }
  return { ok: true, restreints };
}

/** Le remède, nommé : le territoire d'un KAM se règle sur sa ligne (§118.30). */
export const REFUS_TERRITOIRE_PAR_SECTEUR =
  "Ce secteur est le territoire propre d'un KAM : il se règle sur sa ligne, dans « KAM de la BU » (bouton « Territoire »).";

/** Le refus d'une BU de ville nomme les DEUX remèdes : rien à cocher ici, ou changer son terrain. */
export const REFUS_BU_DE_VILLE =
  "Cette BU est une gamme de ville : il n'y a pas d'établissement à choisir — le secteur du KAM se saisit en texte sur sa ligne. "
  + "Passez la BU en terrain « Hospitalière » ou « les deux » pour choisir des établissements.";

/**
 * LE NOM PAR DÉFAUT DU TERRITOIRE D'UN KAM — « Territoire — <KAM> », suffixé quand ce nom est déjà pris dans la BU (un
 * ancien secteur, un homonyme) : la règle de la migration.
 */
export async function nomParDefautDuTerritoire(businessUnitId: string, kamName: string, repId: string): Promise<string> {
  const base = nomDuTerritoire(kamName, repId, false);
  const pris = await prisma.salesSector.findFirst({
    where: { businessUnitId, name: { equals: base, mode: "insensitive" } },
    select: { id: true },
  });
  return nomDuTerritoire(kamName, repId, Boolean(pris));
}

/**
 * UN KAM QUI REVIENT DANS UNE BU — dans la transaction de son rattachement (qui l'a déjà retiré des secteurs de son
 * ancienne BU) : son territoire propre lui est rendu s'il en avait un dans la nouvelle. `true` = rendu.
 */
export async function rendreSonTerritoire(tx: Prisma.TransactionClient, repId: string, nouvelleBu: string | null): Promise<boolean> {
  // SON TERRITOIRE PROPRE LUI EST RENDU quand il revient dans une BU où il en avait un (04/10/2026).
  // Quitter la BU lui retire l'affectation (ci-dessus) mais garde le territoire en sommeil : retiré
  // par erreur puis rattaché, il ne doit pas perdre le choix d'établissements qu'on avait fait pour
  // lui. Le lien se recrée dans la MÊME transaction — un KAM ne passe pas par un état où son
  // territoire existe sans le couvrir.
  let rendu = false;
  if (nouvelleBu) {
    const territoire = await tx.salesSector.findUnique({
      where: { businessUnitId_repId: { businessUnitId: nouvelleBu, repId } },
      select: { id: true, isActive: true },
    });
    if (territoire?.isActive) {
      const c = await tx.salesSectorRep.createMany({ data: [{ sectorId: territoire.id, repId }], skipDuplicates: true });
      rendu = c.count > 0;
    }
  }
  return rendu;
}

/** Ce qu'on dit d'un rattachement de KAM : les affectations retirées, le territoire rendu. */
export function phrasesDuRattachement(retires: number, rendu: boolean): string[] {
  return [
    retires > 0 ? `${retires} affectation(s) à un secteur de son ancienne BU lui sont retirées : son panel suit sa nouvelle BU.` : null,
    rendu ? "Son territoire dans cette BU lui est rendu, tel qu'il était." : null,
  ].filter((x): x is string => Boolean(x));
}
