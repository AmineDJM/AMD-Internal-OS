"use server";

import { revalidatePath } from "next/cache";
import { Prisma, type Priority, type SegmentLevel } from "@prisma/client";
import { requireUser } from "@/lib/session";
import { userCan, hasGlobalView, peutAnnuaire } from "@/lib/rbac";
import { annuaireDuPraticien } from "@/lib/annuaires/acces";
import { canAccessEntity } from "@/lib/entity-access";
import { prisma } from "@/lib/prisma";
import { recordAudit } from "@/lib/audit";
import { companyIdForNew } from "@/lib/company";
import { readDirectoryWorkbook } from "@/lib/medical/directory-workbook";
import { parseDirectorySheet, champsAEcrire, type DirectoryImportRow, type DirectoryField } from "@/lib/medical/directory-sheet";
import { cleDEtablissement, indexerEtablissements, serviceParNom } from "@/lib/annuaires/rattachement";
import { completerRattachement } from "@/lib/medical/rattachement-auto";
import { cleDeService } from "@/lib/annuaires/services";
import { ecritureDeSpecialite, indexerSpecialites, lienDeSpecialiteValide } from "@/lib/annuaires/specialites";
import { unresolvedHint } from "@/lib/medical/wilaya";
import { inferWilayas } from "@/lib/medical/wilaya-ai";
import { reposerWilayaCode } from "@/lib/lieux/rattachement-prisma";
import {
  isAnnuaireField, validateAnnuaireValue, composeDoctorName, type AnnuaireField,
} from "@/lib/medical/directory-grid";
import {
  proposeMapping, validateMapping, applyMapping, targetsFor, stdFieldOf,
  canonicalHeaderRow, toCanonicalRow,
  type HeaderProposal, type TargetColumn, type ColumnKind,
} from "@/lib/medical/directory-mapping";
import type { ActionResult } from "@/lib/actions/types";
import { relierALaPersonne } from "@/lib/referentiels/personnes/double-ecriture";

/**
 * IMPORT D'UN ANNUAIRE — n'importe quel fichier, restructuré à notre format.
 *
 * Le fichier arrive tel qu'il existe : les en-têtes du délégué, l'ordre du partenaire, les
 * grades écrits à la main. La reconnaissance (module pur `directory-sheet`) fait le travail de
 * remise en forme ; cette action ne fait qu'écrire — et surtout, elle RAPPORTE.
 *
 * Rapporter est la moitié du travail. Un import qui annonce « terminé » sans dire combien de
 * lignes il a laissées de côté, ni quelle colonne il n'a pas su lire, produit un annuaire
 * incomplet dont plus personne ne se méfie ensuite.
 *
 * ── L'ANNUAIRE DE DESTINATION — le défaut le plus coûteux de cette action ────────────────
 *
 * Elle ne lisait PAS `directoryId`. On créait « Annuaire des infectiologues », on l'ouvrait, on
 * importait — et les fiches partaient dans l'annuaire général, parce que rien dans toute la
 * chaîne (écran, action, écriture) ne portait la destination. L'annuaire visé restait vide et
 * l'annuaire commun se remplissait de trois cents infectiologues. Corrigé aux trois étages.
 *
 * DOUBLONS : un praticien déjà présent (même nom, même établissement) est MIS À JOUR, pas
 * recréé. Réimporter un fichier corrigé est le geste normal — et il ne doit pas doubler
 * l'annuaire. Le rapprochement se fait DANS L'ANNUAIRE VISÉ : un homonyme rangé ailleurs
 * n'est pas le même dossier de travail, et le mettre à jour depuis un autre import
 * modifierait la liste de quelqu'un d'autre sans que personne le demande.
 *
 * CORRESPONDANCE : `mapping` (facultatif) impose colonne par colonne ce que l'écran a validé.
 * Absent, on retombe sur la reconnaissance automatique — c'est le chemin de l'assistant et des
 * imports en lot, qui n'ont personne pour trancher.
 */
export async function importDirectorySheet(formData: FormData): Promise<ActionResult> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "CREATE")) return { ok: false, error: "Non autorisé à alimenter l'annuaire." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choisissez un fichier Excel ou CSV." };

  // L'ANNUAIRE VISÉ. Vide = l'annuaire général, qui reste un choix légitime — mais un choix,
  // désormais, et non le seul aboutissement possible.
  const directoryId = String(formData.get("directoryId") ?? "").trim() || null;
  let directoryName = "l'annuaire général";
  if (directoryId) {
    const dir = await prisma.medicalDirectory.findUnique({
      where: { id: directoryId },
      select: { id: true, name: true, createdById: true, access: { select: { userId: true } } },
    });
    if (!dir) return { ok: false, error: "Annuaire de destination introuvable." };

    // LA MÊME RÈGLE QUE POUR LE LIRE, littéralement recopiée de l'écran (`page.tsx`). Écrire une
    // seconde version « équivalente » est le moyen le plus sûr de les voir diverger : on
    // corrigerait un jour l'une des deux, et l'écriture ouvrirait ce que la lecture ferme.
    const privileged = user.role === "SUPER_ADMIN" || hasGlobalView(user.role);
    const peutOuvrir =
      privileged || dir.access.length === 0 || dir.createdById === user.id
      || dir.access.some((a) => a.userId === user.id);
    if (!peutOuvrir) return { ok: false, error: "Cet annuaire est réservé à des personnes désignées." };
    directoryName = `« ${dir.name} »`;
  }

  let sheet: unknown[][];
  try {
    sheet = readDirectoryWorkbook(Buffer.from(await file.arrayBuffer()));
  } catch {
    return { ok: false, error: "Fichier illisible : attendu un classeur Excel (.xlsx, .xls) ou un CSV." };
  }
  if (sheet.length < 2) return { ok: false, error: "Le fichier ne contient aucune ligne sous l'en-tête." };

  // LA CORRESPONDANCE CHOISIE À L'ÉCRAN, quand il y en a une. On reconstruit alors une feuille
  // canonique (une colonne par champ, nommée comme notre export) que le parseur existant sait
  // déjà lire : la reconnaissance des grades, secteurs et wilayas n'existe qu'en un exemplaire.
  const mappingRaw = String(formData.get("mapping") ?? "").trim();
  let customByRow: Record<string, string>[] = [];
  // LES COLONNES QUE LE FICHIER PORTE, quand la personne les a rattachées à l'écran : la feuille
  // reconstruite ci-dessous est CANONIQUE (toutes les colonnes, vides ou non), elle ne le dit plus.
  let presentsImposes: Set<DirectoryField> | undefined;
  if (mappingRaw) {
    let mapping: (string | null)[];
    try {
      mapping = JSON.parse(mappingRaw) as (string | null)[];
    } catch {
      return { ok: false, error: "Correspondance des colonnes illisible." };
    }
    const problemes = validateMapping(mapping);
    if (problemes.length > 0) return { ok: false, error: problemes[0].message };
    presentsImposes = new Set(mapping.map(stdFieldOf).filter((f): f is DirectoryField => f !== null));

    const corps = sheet.slice(1);
    const canoniques: unknown[][] = [canonicalHeaderRow()];
    customByRow = [];
    for (const ligne of corps) {
      const { standard, custom } = applyMapping(ligne, mapping);
      canoniques.push(toCanonicalRow(standard));
      customByRow.push(custom);
    }
    sheet = canoniques;
  }

  const parsed = parseDirectorySheet(sheet, presentsImposes);
  if (parsed.rows.length === 0) {
    return {
      ok: false,
      error: parsed.matched.includes("name")
        ? "Aucune ligne exploitable : les fiches sans nom ne peuvent pas être importées."
        : "Colonne « Nom » introuvable : nommez-la Nom, Praticien, Médecin ou Nom et prénom.",
    };
  }

  // Les délégués sont rattachés PAR LEUR NOM tel qu'il figure dans le fichier — un annuaire
  // venu de l'extérieur ne connaît pas nos identifiants. Un nom inconnu laisse la fiche non
  // attribuée plutôt que de la rattacher au hasard.
  const delegateNames = [...new Set(parsed.rows.map((r) => r.delegate).filter((n): n is string => Boolean(n)))];
  const delegates = delegateNames.length
    ? await prisma.user.findMany({ where: { name: { in: delegateNames } }, select: { id: true, name: true } })
    : [];
  const delegateByName = new Map(delegates.map((d) => [d.name.toLowerCase(), d.id]));

  // LA WILAYA EN RENFORT D'IA — pour ce que la reconnaissance ne peut pas savoir : « Rouiba »,
  // « Bab Ezzouar », « El Harrach » sont des communes d'Alger, mais rien dans leur nom ne le
  // dit. UN SEUL appel pour tout le fichier, et chaque réponse revalidée contre les 58 wilayas :
  // une hallucination ne doit jamais entrer dans un champ à liste fermée.
  const needAi = parsed.rows.filter((r) => !r.wilaya);
  if (needAi.length > 0) {
    const hintOf = (r: DirectoryImportRow) => unresolvedHint({ city: r.city, address: r.address, institution: r.institution });
    const guessed = await inferWilayas(needAi.map(hintOf));
    if (guessed.size > 0) {
      for (const r of needAi) {
        const w = guessed.get(hintOf(r));
        if (w) r.wilaya = w;
      }
    }
  }
  const aiFilled = needAi.filter((r) => r.wilaya).length;

  const companyId = await companyIdForNew(user.id);
  const presents = parsed.presents;

  // QUI POSSÈDE CE QU'ON IMPORTE. Qui ne voit pas TOUS les praticiens (un délégué : sa portée est
  // « ses » praticiens) possède les fiches qu'il crée — c'est la règle de l'ajout à la main
  // (`addDirectoryDoctor`). L'import ne l'appliquait pas : un délégué importait cinquante
  // praticiens, l'action annonçait « 50 fiches créées », et la feuille ne lui en montrait aucune —
  // elles n'appartenaient à personne, donc pas à lui. Et la colonne « Délégué » d'un fichier ne
  // lui donne pas le droit d'attribuer des fiches à d'autres : seul celui qui voit tout attribue.
  const voitTout = user.access.modules.get("MEDICAL")?.scope === "ALL";
  const proprietaireImpose = voitTout ? null : user.id;
  const delegueDuFichier = (r: DirectoryImportRow): string | null =>
    r.delegate ? delegateByName.get(r.delegate.toLowerCase()) ?? null : null;
  const delegueInconnu = new Set<string>();
  for (const r of parsed.rows) if (r.delegate && !delegueDuFichier(r)) delegueInconnu.add(r.delegate);

  // LE RAPPROCHEMENT — « même praticien » = même nom ET même établissement, dans l'annuaire visé.
  // Un fichier SANS colonne d'établissement ne dit pas l'établissement : chercher « nom + vide »
  // ne retrouvait que les fiches sans établissement, et chaque praticien hospitalier était recréé
  // en double à chaque import de ce fichier. Sans cette colonne, on rapproche par le NOM seul —
  // et un nom porté par deux fiches de l'annuaire (deux homonymes, deux hôpitaux) ne désigne
  // personne : la ligne est écartée et DITE, jamais rattachée au hasard (§118.34).
  const parEtablissement = presents.has("institution");
  const cleNom = (n: string) => n.toLowerCase();
  // L'établissement se compare comme l'annuaire des établissements le compare (casse, accents,
  // espaces) : une fiche rattachée porte le nom CANONIQUE (« Hôpital Mustapha »), et le même
  // fichier réimporté (« hopital mustapha ») doit la retrouver au lieu d'en créer une jumelle.
  const key = (r: { name: string; institution: string | null }) =>
    parEtablissement ? `${cleNom(r.name)}|${cleDEtablissement(r.institution ?? "")}` : cleNom(r.name);

  // On relit les fiches existantes portant l'un des noms du fichier : c'est la seule façon de
  // reconnaître un doublon sans charger tout l'annuaire.
  //
  // LE RAPPROCHEMENT EST CANTONNÉ À L'ANNUAIRE VISÉ. Sans ce filtre, importer « Dr Benali » dans
  // l'annuaire des infectiologues METTAIT À JOUR le « Dr Benali » de l'annuaire des cardiologues
  // — c'est-à-dire modifiait la liste de quelqu'un d'autre, et n'en créait aucune dans la sienne.
  const existing = await prisma.medicalDoctor.findMany({
    where: { name: { in: [...new Set(parsed.rows.map((r) => r.name))] }, directoryId },
    select: {
      id: true, name: true, institution: true, institutionId: true, serviceId: true,
      lastName: true, firstName: true, specialty: true, wilaya: true, custom: true,
    },
  });
  type Existante = (typeof existing)[number];
  const existingByKey = new Map<string, Existante>();
  const homonymes = new Set<string>();
  for (const d of existing) {
    const k = key(d);
    if (existingByKey.has(k)) homonymes.add(k); else existingByKey.set(k, d);
  }

  // LA PORTÉE, FICHE PAR FICHE — la MÊME règle que la cellule de la feuille (`canAccessEntity`).
  // Le rapprochement ne la regardait pas : un délégué qui importait « Dr Benali » mettait à jour
  // le Dr Benali d'un collègue (son téléphone, son grade, son délégué) — une écriture que la
  // feuille lui aurait refusée cellule par cellule (§118.71). Une fiche hors de sa portée n'est
  // ni modifiée ni dupliquée : la ligne est écartée et comptée.
  const clesDuFichier = new Set(parsed.rows.map(key));
  const modifiables = new Set<string>();
  for (const d of existingByKey.values()) {
    if (clesDuFichier.has(key(d)) && await canAccessEntity(user, "DOCTOR", d.id, "UPDATE")) modifiables.add(d.id);
  }

  // L'ANNUAIRE DES ÉTABLISSEMENTS (§118.172) — lu UNE fois, interrogé ligne par ligne. Un nom
  // rattache s'il désigne UN SEUL établissement actif, au caractère près (casse, accents et
  // espaces mis à part) ; sinon il reste un texte « à rattacher », et le message le dit.
  const etablissements = presents.has("institution") || presents.has("service")
    ? await prisma.medicalInstitution.findMany({
        select: { id: true, name: true, isActive: true, wilaya: true, services: { select: { id: true, name: true } } },
      })
    : [];
  const resoudreEtab = indexerEtablissements(etablissements);
  // LE RÉFÉRENTIEL DES SPÉCIALITÉS (§118.180) — même règle : un texte relie à UNE spécialité à coup
  // sûr ; sinon il reste écrit, sans lien, et le bilan le nomme. Lu une fois, seulement si le
  // fichier porte une spécialité (la colonne, ou le service qui en tient lieu).
  const resoudreSpecialite = presents.has("specialty") || presents.has("service")
    ? indexerSpecialites(await prisma.medicalSpecialty.findMany({ select: { id: true, name: true } }))
    : indexerSpecialites([]);
  const specialitesHorsReferentiel = new Set<string>();
  const servicesDe = new Map(etablissements.map((e) => [e.id, e.services]));
  const nomDeEtab = new Map(etablissements.map((e) => [e.id, e.name]));
  let rattachees = 0;
  const etabsARattacher = new Map<string, "inconnu" | "ambigu" | "inactif">();
  const servicesInconnus = new Set<string>();

  let created = 0;
  let updated = 0;
  let horsPortee = 0;
  let ambiguesNom = 0;
  for (const row of parsed.rows) {
    // LES VALEURS SUR MESURE, retrouvées par l'INDICE DE LA LIGNE DU FICHIER. Les apparier par
    // position dans le résultat aurait donné à chaque praticien les valeurs de son voisin dès
    // qu'une ligne vide ou sans nom traverse le fichier — sans qu'aucune erreur ne s'affiche.
    const sur = customByRow[row.sourceIndex];
    const custom = sur && Object.keys(sur).length > 0 ? sur : null;

    const k = key(row);
    if (homonymes.has(k)) { ambiguesNom += 1; continue; }
    const existant = existingByKey.get(k) ?? null;
    if (existant && !modifiables.has(existant.id)) { horsPortee += 1; continue; }

    // L'ÉTABLISSEMENT ET LE SERVICE — des LIENS, jamais devinés.
    const lien: { institutionId?: string | null; institution?: string | null; serviceId?: string | null } = {};
    if (presents.has("institution")) {
      const texte = row.institution;
      const lieAvant = existant?.institutionId ?? null;
      if (!texte) {
        if (existant && (lieAvant || existant.institution)) Object.assign(lien, { institutionId: null, institution: null, serviceId: null });
      } else {
        const r = resoudreEtab(texte);
        if (r.statut === "trouve") {
          if (r.etablissement.id !== lieAvant) { lien.institutionId = r.etablissement.id; rattachees += 1; }
          lien.institution = r.etablissement.name;
        } else if (lieAvant && cleDEtablissement(existant?.institution ?? "") === cleDEtablissement(texte)) {
          // DÉJÀ LIÉE à l'établissement que le texte nomme — désactivé depuis, ou devenu homonyme
          // d'un autre : le lien d'avant reste. Le casser parce que le nom ne désigne plus un seul
          // hôpital retirerait une information juste.
        } else {
          lien.institutionId = null;
          lien.institution = texte;
          if (!etabsARattacher.has(texte)) etabsARattacher.set(texte, r.statut);
        }
      }
    }
    const etabFinal = lien.institutionId !== undefined ? lien.institutionId : existant?.institutionId ?? null;
    if (presents.has("service")) {
      if (!row.service) {
        if (existant?.serviceId) lien.serviceId = null;
      } else if (etabFinal) {
        const svc = serviceParNom(servicesDe.get(etabFinal) ?? [], row.service, cleDeService);
        if (svc) lien.serviceId = svc.id;
        // UN SERVICE QUE L'ÉTABLISSEMENT N'A PAS n'est jamais créé depuis un fichier : « Cardio »
        // à côté de « Cardiologie » ferait deux services pour un. Il est DIT, pour qu'on l'ajoute
        // dans l'annuaire des établissements s'il existe vraiment.
        else servicesInconnus.add(`${nomDeEtab.get(etabFinal) ?? "?"} › ${row.service}`);
      } else {
        servicesInconnus.add(`${row.institution ?? "sans établissement"} › ${row.service}`);
      }
    }
    // Un service n'appartient qu'à SON établissement : changer d'établissement le retire, sauf
    // si la même ligne en désigne un du nouveau.
    if (lien.institutionId !== undefined && lien.institutionId !== (existant?.institutionId ?? null) && lien.serviceId === undefined) {
      lien.serviceId = null;
    }

    const champs = champsAEcrire(row, presents, existant) as Record<string, unknown>;
    if ("specialty" in champs) {
      const ecr = ecritureDeSpecialite(champs.specialty as string | null, resoudreSpecialite);
      champs.specialty = ecr.specialty;
      champs.specialtyId = ecr.specialtyId;
      if (ecr.specialty && !ecr.specialtyId) specialitesHorsReferentiel.add(ecr.specialty);
    }
    const delegueLu = delegueDuFichier(row);

    if (existant) {
      // On FUSIONNE les colonnes sur mesure au lieu de remplacer le JSON : un fichier qui ne
      // porte que deux colonnes ne doit pas effacer les huit autres déjà saisies à la main.
      const base = (existant.custom && typeof existant.custom === "object" && !Array.isArray(existant.custom)
        ? existant.custom : {}) as Prisma.InputJsonObject;
      await prisma.medicalDoctor.update({
        where: { id: existant.id },
        data: {
          ...(champs as Prisma.MedicalDoctorUncheckedUpdateInput),
          ...lien,
          // LE DÉLÉGUÉ, seulement par qui voit tout, et seulement nommé à coup sûr : une cellule vide
          // ou un nom inconnu ne retire pas une fiche à celui qui la suit.
          ...(voitTout && presents.has("delegate") && delegueLu ? { delegateId: delegueLu } : {}),
          ...(custom ? { custom: { ...base, ...custom } } : {}),
          updatedById: user.id,
        },
      });
      updated += 1;
    } else {
      const doc = await prisma.medicalDoctor.create({
        data: {
          ...(champs as Omit<Prisma.MedicalDoctorUncheckedCreateInput, "name">),
          name: row.name, companyId, directoryId,
          ...lien,
          institution: lien.institution !== undefined ? lien.institution : row.institution,
          delegateId: proprietaireImpose ?? delegueLu,
          ...(custom ? { custom } : {}),
          createdById: user.id, updatedById: user.id,
        },
        select: { id: true, name: true, institution: true, institutionId: true, serviceId: true, lastName: true, firstName: true, specialty: true, wilaya: true, custom: true },
      });
      // Un même fichier peut lister deux fois la même personne : la seconde occurrence doit
      // mettre à jour la fiche qu'on vient de créer, pas en créer une jumelle — sous la même clé
      // que celle qui l'a cherchée (le nom retenu peut différer du texte du fichier).
      existingByKey.set(k, doc);
      modifiables.add(doc.id);
      created += 1;
    }
  }

  // LE RATTACHEMENT AUTOMATIQUE (Direction, 06/10) : une fiche importée sans établissement reçoit celui que sa
  // wilaya et sa spécialité désignent à coup sûr, et son service = sa spécialité ; « à trancher » n'écrit rien.
  const auto = await completerRattachement([...modifiables], user.id);
  // DOUBLE ÉCRITURE DES LIEUX (refonte V2-D) : les wilayas importées (ou complétées par l'établissement) deviennent
  // aussi le code officiel. Après le rattachement : il a pu poser la wilaya d'une fiche qui n'en avait pas.
  await reposerWilayaCode("MedicalDoctor", [...modifiables]);

  // Avec une correspondance explicite, il n'y a plus de « colonne non reconnue » : ce qui n'est
  // pas rattaché l'a été SCIEMMENT. Ne le rapporter que sur le chemin automatique évite un
  // avertissement qui inquiète pour une décision qu'on vient de prendre soi-même.
  const unknownCols = mappingRaw ? [] : parsed.unknown.map((u) => u.header);
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Promotion médicale",
    summary: `Import dans ${directoryName} — ${created} créé(s), ${updated} mis à jour, ${parsed.skipped} ignoré(s)${horsPortee + ambiguesNom > 0 ? `, ${horsPortee + ambiguesNom} écartée(s)` : ""}${rattachees > 0 ? ` · ${rattachees} rattachée(s) à un établissement` : ""}${aiFilled > 0 ? ` · ${aiFilled} wilaya(s) déduite(s) par l'assistant` : ""}${unknownCols.length ? ` · colonnes non reconnues : ${unknownCols.join(", ")}` : ""}`,
  });

  revalidatePath("/medical");
  revalidatePath("/medical/annuaire");
  revalidatePath("/annuaires");

  // LA DESTINATION EST DITE. C'est ce qui manquait pour s'apercevoir du défaut : le message
  // annonçait « 312 fiches créées » sans jamais nommer l'annuaire, donc sans jamais contredire
  // ce qu'on croyait avoir fait.
  const parts = [`${created} fiche(s) créée(s)`, `${updated} mise(s) à jour`, `dans ${directoryName}`];
  if (parsed.skipped > 0) parts.push(`${parsed.skipped} ligne(s) sans nom ignorée(s)`);
  // CE QUI N'A PAS ÉTÉ ÉCRIT EST COMPTÉ — une ligne écartée en silence se lit comme une ligne
  // importée (§118.52).
  if (horsPortee > 0) parts.push(`${horsPortee} praticien(s) déjà présent(s) hors de votre portée, laissé(s) tel(s) quel(s)`);
  if (ambiguesNom > 0) parts.push(`${ambiguesNom} ligne(s) écartée(s) : plusieurs fiches portent ce nom — ajoutez la colonne « Établissement » pour les distinguer`);
  if (rattachees > 0) parts.push(`${rattachees} rattachée(s) à l'annuaire des établissements`);
  if (auto.etablissements > 0) parts.push(`${auto.etablissements} rattachée(s) automatiquement par leur wilaya et leur spécialité`);
  if (auto.services > 0) parts.push(`${auto.services} service(s) posé(s) d'après la spécialité`);
  if (etabsARattacher.size > 0) {
    const liste = [...etabsARattacher.entries()];
    const raison = (r: "inconnu" | "ambigu" | "inactif") => (r === "ambigu" ? "plusieurs établissements de ce nom" : r === "inactif" ? "établissement désactivé" : "absent de l'annuaire");
    parts.push(`établissement(s) à rattacher à la main : ${liste.slice(0, 5).map(([n, r]) => `« ${n} » (${raison(r)})`).join(", ")}${liste.length > 5 ? ` et ${liste.length - 5} autre(s)` : ""}`);
  }
  if (specialitesHorsReferentiel.size > 0) {
    const liste = [...specialitesHorsReferentiel];
    parts.push(`spécialité(s) hors référentiel, gardée(s) écrite(s) sans lien : ${liste.slice(0, 5).map((n) => `« ${n} »`).join(", ")}${liste.length > 5 ? ` et ${liste.length - 5} autre(s)` : ""} (à rattacher dans Annuaires › Spécialités)`);
  }
  if (servicesInconnus.size > 0) {
    const liste = [...servicesInconnus];
    parts.push(`service(s) non rattaché(s) — absent(s) de leur établissement : ${liste.slice(0, 5).join(", ")}${liste.length > 5 ? ` et ${liste.length - 5} autre(s)` : ""} (à ajouter dans Annuaires › Établissements)`);
  }
  if (delegueInconnu.size > 0 && voitTout) parts.push(`délégué(s) introuvable(s) — les fiches existantes gardent leur délégué, les nouvelles n'en ont pas : ${[...delegueInconnu].slice(0, 5).join(", ")}`);
  if (presents.has("delegate") && !voitTout) parts.push("colonne « Délégué » non appliquée : les fiches que vous créez vous sont attribuées");
  if (unknownCols.length) parts.push(`colonne(s) non reconnue(s) : ${unknownCols.join(", ")}`);
  // UN NIVEAU ILLISIBLE N'EST NI ÉCRIT NI TU : la fiche garde le sien (ou le défaut, si elle est
  // neuve), et la cellule est nommée — sinon « Très bon » mal orthographié deviendrait un silence.
  const illisibles = parsed.rows.flatMap((r) => r.niveauxIllisibles);
  if (illisibles.length > 0) {
    const nom = { influence: "Influence", potential: "Potentiel", affinity: "Affinité" } as const;
    parts.push(`${illisibles.length} niveau(x) illisible(s) non écrit(s) : ${illisibles.slice(0, 5).map((i) => `« ${i.valeur} » (${nom[i.champ]})`).join(", ")}${illisibles.length > 5 ? ` et ${illisibles.length - 5} autre(s)` : ""}`);
  }
  return { ok: true, message: parts.join(" · ") };
}

/**
 * L'APERÇU AVANT IMPORT — ce que le fichier contient, et ce qu'on propose d'en faire.
 *
 * Rien n'est écrit ici. On lit le classeur, on propose une correspondance colonne par colonne
 * avec son ORIGINE (exact / alias / rien), et on rend trois valeurs d'exemple par colonne pour
 * qu'on puisse juger sans rouvrir le fichier à côté.
 *
 * C'est l'étape qui manquait : jusqu'ici, une colonne que la reconnaissance ne connaissait pas
 * était annoncée dans le message de fin — après l'écriture — et son contenu était perdu.
 */
export async function previewDirectorySheet(formData: FormData): Promise<
  ActionResult & { preview?: { proposals: HeaderProposal[]; targets: TargetColumn[]; rowCount: number } }
> {
  const user = await requireUser();
  if (!userCan(user, "MEDICAL", "CREATE")) return { ok: false, error: "Non autorisé à alimenter l'annuaire." };

  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choisissez un fichier Excel ou CSV." };

  let sheet: unknown[][];
  try {
    sheet = readDirectoryWorkbook(Buffer.from(await file.arrayBuffer()));
  } catch {
    return { ok: false, error: "Fichier illisible : attendu un classeur Excel (.xlsx, .xls) ou un CSV." };
  }
  if (sheet.length < 2) return { ok: false, error: "Le fichier ne contient aucune ligne sous l'en-tête." };

  const directoryId = String(formData.get("directoryId") ?? "").trim() || null;
  const colonnes = directoryId
    ? await prisma.medicalDirectoryColumn.findMany({
        where: { directoryId },
        orderBy: { position: "asc" },
        select: { key: true, label: true, kind: true, options: true },
      })
    : [];

  const custom = colonnes.map((c) => ({ ...c, kind: c.kind as ColumnKind }));
  const corps = sheet.slice(1);
  return {
    ok: true,
    preview: {
      proposals: proposeMapping(sheet[0], corps, custom),
      targets: targetsFor(custom),
      rowCount: corps.filter((r) => r.some((c) => String(c ?? "").trim())).length,
    },
  };
}

/** Une fois par clic : au-delà, c'est une migration, et on la fait par vues (wilaya, annuaire nommé). */
const RATTACHEMENT_MAX = 2000;

/** L'échelle de potentiel tient à jour l'ancien champ de priorité (lecteurs hérités). */
const segToPriority: Record<SegmentLevel, Priority> = {
  VERY_HIGH: "CRITICAL", HIGH: "HIGH", MEDIUM: "MEDIUM", LOW: "LOW", VERY_LOW: "LOW",
};

/**
 * ÉCRITURE D'UNE SEULE CELLULE — l'annuaire édité comme une vraie feuille.
 *
 * Chaque correction (une wilaya, un grade, un numéro) part seule : on clique, on tape, on passe à
 * la cellule suivante. Le champ est validé par le module pur (les menus déroulants n'acceptent que
 * leurs options), la portée est la MÊME que partout ailleurs (`canAccessEntity` — un délégué ne
 * touche que ses praticiens), et le nom d'affichage se recompose quand on change le nom ou le
 * prénom, pour que le reste de l'outil (visites, congrès) reste cohérent.
 */
export async function saveDirectoryCell(input: { id: string; field: string; value: string }): Promise<ActionResult> {
  const user = await requireUser();
  const { id, field, value } = input;
  if (!id) return { ok: false, error: "Fiche introuvable." };
  if (!isAnnuaireField(field)) return { ok: false, error: "Colonne inconnue." };
  if (!(await canAccessEntity(user, "DOCTOR", id, "UPDATE"))) return { ok: false, error: "Non autorisé à modifier cette fiche." };

  const checked = validateAnnuaireValue(field as AnnuaireField, value);
  if (!checked.ok) return { ok: false, error: checked.error };
  const v = checked.value;

  const before = await prisma.medicalDoctor.findUnique({
    where: { id },
    select: { firstName: true, lastName: true, institutionId: true, serviceId: true, wilaya: true },
  });
  if (!before) return { ok: false, error: "Fiche introuvable." };

  const data: Record<string, unknown> = { updatedById: user.id };
  switch (field as AnnuaireField) {
    case "institution": {
      // LE LIEN VERS L'ANNUAIRE DES ÉTABLISSEMENTS (§118.172). Vide = la fiche n'a plus
      // d'établissement — ni lien, ni texte, ni service (un service n'existe que dans le sien).
      if (v === null) {
        data.institutionId = null; data.institution = null; data.serviceId = null;
        break;
      }
      const etab = await prisma.medicalInstitution.findUnique({ where: { id: v }, select: { id: true, name: true, isActive: true, wilaya: true } });
      if (!etab) return { ok: false, error: "Cet établissement n'existe pas (ou plus) dans l'annuaire des établissements — rechargez la feuille." };
      if (etab.id === before.institutionId) return { ok: true };
      // ON NE RATTACHE PAS À UN HÔPITAL FERMÉ. Une fiche déjà rattachée à un établissement
      // désactivé le GARDE (c'est un fait d'histoire) ; on ne l'y range plus.
      if (!etab.isActive) {
        return { ok: false, error: `« ${etab.name} » est désactivé dans l'annuaire des établissements : réactivez-le d'abord (Annuaires › Établissements), ou choisissez-en un autre.` };
      }
      data.institutionId = etab.id;
      // Le libellé dénormalisé suit le lien : visites, congrès et tournées le lisent tel quel.
      data.institution = etab.name;
      // LE SERVICE SUIT SON ÉTABLISSEMENT : celui de l'ancien hôpital n'existe pas dans le nouveau.
      data.serviceId = null;
      // Une fiche SANS wilaya prend celle de son établissement (In / Out, secteur) ; une wilaya posée n'est pas écrasée.
      if (!before.wilaya?.trim() && etab.wilaya?.trim()) data.wilaya = etab.wilaya;
      break;
    }
    case "service": {
      if (v === null) { data.serviceId = null; break; }
      if (!before.institutionId) {
        return { ok: false, error: "Choisissez d'abord l'établissement de la fiche : un service est toujours celui d'un établissement." };
      }
      const service = await prisma.medicalInstitutionService.findUnique({ where: { id: v }, select: { institutionId: true } });
      if (!service) return { ok: false, error: "Ce service n'existe plus dans l'annuaire des établissements — rechargez la feuille." };
      // Le menu ne propose que les services de l'établissement de la ligne ; une requête forgée
      // ignore un menu — c'est ici que la règle se tient.
      if (service.institutionId !== before.institutionId) {
        return { ok: false, error: "Ce service n'appartient pas à l'établissement de la fiche." };
      }
      data.serviceId = v;
      break;
    }
    case "lastName":
    case "firstName": {
      data[field] = v;
      const first = field === "firstName" ? v : before.firstName;
      const last = field === "lastName" ? v : before.lastName;
      const name = composeDoctorName(first, last);
      if (name) data.name = name; // un nom vide n'écrase pas le libellé existant
      break;
    }
    case "specialty": {
      // UN LIEN QUAND C'EST SÛR, LE TEXTE SINON (§118.180). Cette cellule écrivait le texte et
      // EFFAÇAIT le lien : taper « Cardiologie » rendait la fiche « sans spécialité » pour tout ce
      // qui lit le référentiel. Le texte se résout maintenant : une spécialité à coup sûr → le lien
      // et SON nom ; sinon le texte tel quel, sans lien — et la feuille le signale « à rattacher ».
      const referentiel = await prisma.medicalSpecialty.findMany({ select: { id: true, name: true } });
      const ecr = ecritureDeSpecialite(v, indexerSpecialites(referentiel));
      data.specialty = ecr.specialty;
      data.specialtyId = ecr.specialtyId;
      break;
    }
    case "potential":
      data.potential = v;
      data.prescriptionPotential = segToPriority[v as SegmentLevel];
      break;
    default:
      data[field] = v; // address, wilaya, postalCode, phone, email, title, sector
  }

  await prisma.medicalDoctor.update({ where: { id }, data });
  // LE RATTACHEMENT AUTOMATIQUE suit chaque geste qui le nourrit : une wilaya ou une spécialité posée sur une fiche
  // sans établissement, un établissement choisi sans service (service = spécialité).
  if (field === "wilaya" || field === "specialty" || field === "institution") await completerRattachement([id], user.id);
  // DOUBLE ÉCRITURE DES LIEUX (refonte V2-D) : la cellule wilaya — ou l'établissement qui l'a complétée — pose le code.
  if (field === "wilaya" || field === "institution") await reposerWilayaCode("MedicalDoctor", id);
  revalidatePath("/medical/annuaire");
  revalidatePath("/annuaires");
  revalidatePath("/medical");
  return { ok: true };
}

/**
 * RATTACHER LES FICHES D'AVANT LE LIEN — en lot, par le NOM, et seulement à coup sûr (§118.172).
 *
 * Avant ce lot, l'établissement d'un praticien était un texte tapé à la main. Des centaines de
 * fiches portent donc « CHU Mustapha » SANS lien vers l'annuaire des établissements : la feuille
 * les montre « à rattacher », et les rattacher une à une, personne ne le fait. Ce geste rattache
 * celles dont le texte désigne UN SEUL établissement actif, au caractère près (`rattachement.ts`),
 * et DIT les autres — homonymes, inconnus, désactivés — pour qu'on les rattache à la main.
 *
 * Il ne touche QUE les fiches que la personne peut modifier (la règle de la cellule), et que la
 * vue qu'elle regarde contient (`ids`) : un clic dans l'annuaire des pharmaciens ne rattache pas
 * les médecins d'un annuaire qu'elle n'a pas ouvert.
 */
export async function rattacherEtablissementsParNom(input: { ids: string[] }): Promise<ActionResult & { rattachees?: number }> {
  const user = await requireUser();
  const ids = [...new Set((input.ids ?? []).map((i) => String(i).trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Aucune fiche à rattacher dans cette vue." };
  if (ids.length > RATTACHEMENT_MAX) {
    return { ok: false, error: `${ids.length} fiches d'un coup : c'est plus que les ${RATTACHEMENT_MAX} qu'un rattachement traite — filtrez la feuille (une wilaya, un annuaire nommé) et recommencez.` };
  }
  const fiches = await prisma.medicalDoctor.findMany({
    where: { id: { in: ids }, institutionId: null, institution: { not: null } },
    select: { id: true, institution: true },
  });
  const etablissements = await prisma.medicalInstitution.findMany({ select: { id: true, name: true, isActive: true, wilaya: true } });
  const resoudre = indexerEtablissements(etablissements);

  let rattachees = 0;
  let horsPortee = 0;
  const restent = new Map<string, "inconnu" | "ambigu" | "inactif">();
  for (const f of fiches) {
    const r = resoudre(f.institution);
    if (r.statut !== "trouve") {
      if (f.institution && !restent.has(f.institution)) restent.set(f.institution, r.statut);
      continue;
    }
    if (!(await canAccessEntity(user, "DOCTOR", f.id, "UPDATE"))) { horsPortee += 1; continue; }
    // L'écriture est CONDITIONNELLE : une fiche rattachée entre la lecture et ce clic (par la
    // feuille, par un autre onglet) garde le choix qu'on vient d'y faire.
    const { count } = await prisma.medicalDoctor.updateMany({
      where: { id: f.id, institutionId: null },
      data: { institutionId: r.etablissement.id, institution: r.etablissement.name, serviceId: null, updatedById: user.id },
    });
    rattachees += count;
  }
  if (rattachees > 0) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Annuaires",
      summary: `Annuaire des praticiens — ${rattachees} fiche(s) rattachée(s) à l'annuaire des établissements par leur nom`,
    });
    revalidatePath("/medical/annuaire");
    revalidatePath("/annuaires");
  }
  const parts = [rattachees > 0 ? `${rattachees} fiche(s) rattachée(s) à l'annuaire des établissements` : "Aucune fiche rattachée"];
  if (horsPortee > 0) parts.push(`${horsPortee} hors de votre portée, laissée(s) telle(s) quelle(s)`);
  if (restent.size > 0) {
    const liste = [...restent.entries()];
    const raison = (r: "inconnu" | "ambigu" | "inactif") => (r === "ambigu" ? "plusieurs établissements de ce nom" : r === "inactif" ? "établissement désactivé" : "absent de l'annuaire");
    parts.push(`à rattacher à la main : ${liste.slice(0, 6).map(([n, r]) => `« ${n} » (${raison(r)})`).join(", ")}${liste.length > 6 ? ` et ${liste.length - 6} autre(s)` : ""}`);
  }
  return { ok: true, rattachees, message: parts.join(" · ") };
}

/**
 * RATTACHER AUTOMATIQUEMENT les fiches de la vue (Direction, 06/10) : l'établissement que la wilaya et la spécialité
 * désignent à coup sûr (un seul hôpital de la wilaya, ou un seul qui a le service de la spécialité), et le service =
 * la spécialité. Les fiches « à trancher » ne sont pas touchées : la feuille les montre avec leurs candidats.
 */
export async function rattacherAutomatiquement(input: { ids: string[] }): Promise<ActionResult & { rattachees?: number }> {
  const user = await requireUser();
  const ids = [...new Set((input.ids ?? []).map((i) => String(i).trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Aucune fiche à rattacher dans cette vue." };
  if (ids.length > RATTACHEMENT_MAX) return { ok: false, error: `${ids.length} fiches d'un coup : c'est plus que les ${RATTACHEMENT_MAX} qu'un rattachement traite — filtrez la feuille et recommencez.` };
  const modifiables: string[] = [];
  for (const id of ids) if (await canAccessEntity(user, "DOCTOR", id, "UPDATE")) modifiables.push(id);
  const r = await completerRattachement(modifiables, user.id);
  if (r.etablissements + r.services > 0) {
    await recordAudit({ actorId: user.id, action: "UPDATE", module: "Annuaires", summary: `Rattachement automatique — ${r.etablissements} établissement(s) déduit(s) de la wilaya et de la spécialité, ${r.services} service(s) posé(s) d'après la spécialité` });
    revalidatePath("/medical/annuaire");
    revalidatePath("/annuaires");
  }
  const horsPortee = ids.length - modifiables.length;
  const parts = [`${r.etablissements} fiche(s) rattachée(s) à leur établissement`, `${r.services} service(s) posé(s) d'après la spécialité`];
  if (horsPortee > 0) parts.push(`${horsPortee} hors de votre portée, laissée(s) telle(s) quelle(s)`);
  return { ok: true, rattachees: r.etablissements, message: parts.join(" · ") };
}

/**
 * RATTACHER LES SPÉCIALITÉS ÉCRITES EN TEXTE — en lot, par le NOM, et seulement à coup sûr (§118.180).
 *
 * La même règle que pour les établissements (§118.172) : une fiche dont le texte désigne UNE SEULE
 * spécialité du référentiel, casse, accents et espaces mis à part, reçoit le lien ; les autres —
 * inconnues du référentiel, ou désignant deux entrées qui ne diffèrent que par un accent — sont
 * DITES, pour qu'on les crée ou qu'on fusionne le doublon. On ne touche que ce que la personne peut
 * modifier, et que la vue qu'elle regarde contient (`ids`).
 *
 * « Sans lien » veut dire ce que la feuille montre : pas de lien, OU un lien que le texte contredit
 * (`lienDeSpecialiteValide` — l'ancien import remplaçait le texte sans toucher au lien). C'est alors
 * le TEXTE qui se résout, puisque c'est la saisie la plus récente.
 */
export async function rattacherSpecialitesParNom(input: { ids: string[] }): Promise<ActionResult & { rattachees?: number }> {
  const user = await requireUser();
  const ids = [...new Set((input.ids ?? []).map((i) => String(i).trim()).filter(Boolean))];
  if (ids.length === 0) return { ok: false, error: "Aucune fiche à rattacher dans cette vue." };
  if (ids.length > RATTACHEMENT_MAX) {
    return { ok: false, error: `${ids.length} fiches d'un coup : c'est plus que les ${RATTACHEMENT_MAX} qu'un rattachement traite — filtrez la feuille et recommencez.` };
  }
  const [fiches, referentiel] = await Promise.all([
    prisma.medicalDoctor.findMany({
      where: { id: { in: ids }, specialty: { not: null } },
      select: { id: true, specialty: true, specialtyId: true, specialtyRef: { select: { name: true } } },
    }),
    prisma.medicalSpecialty.findMany({ select: { id: true, name: true } }),
  ]);
  const resoudre = indexerSpecialites(referentiel);
  let rattachees = 0;
  let horsPortee = 0;
  const restent = new Map<string, "inconnu" | "ambigu">();
  for (const f of fiches) {
    // Déjà rattachée à bon droit : rien à faire.
    if (f.specialtyRef && lienDeSpecialiteValide(f.specialty, f.specialtyRef.name)) continue;
    const r = resoudre(f.specialty);
    if (r.statut !== "trouve") {
      if (f.specialty && (r.statut === "inconnu" || r.statut === "ambigu") && !restent.has(f.specialty)) restent.set(f.specialty, r.statut);
      continue;
    }
    if (!(await canAccessEntity(user, "DOCTOR", f.id, "UPDATE"))) { horsPortee += 1; continue; }
    // CONDITIONNEL — sur ce qu'on a LU, lien et texte : une fiche touchée entre la lecture et ce clic
    // garde le choix qu'on y a fait.
    const { count } = await prisma.medicalDoctor.updateMany({
      where: { id: f.id, specialtyId: f.specialtyId, specialty: f.specialty },
      data: { specialtyId: r.specialite.id, specialty: r.specialite.name, updatedById: user.id },
    });
    rattachees += count;
  }
  if (rattachees > 0) {
    await recordAudit({
      actorId: user.id, action: "UPDATE", module: "Annuaires",
      summary: `Annuaire des praticiens — ${rattachees} fiche(s) rattachée(s) au référentiel des spécialités par leur nom`,
    });
    revalidatePath("/medical/annuaire");
    revalidatePath("/annuaires");
  }
  const parts = [rattachees > 0 ? `${rattachees} fiche(s) rattachée(s) au référentiel des spécialités` : "Aucune fiche rattachée"];
  if (horsPortee > 0) parts.push(`${horsPortee} hors de votre portée, laissée(s) telle(s) quelle(s)`);
  if (restent.size > 0) {
    const liste = [...restent.entries()];
    const raison = (r: "inconnu" | "ambigu") => (r === "ambigu" ? "deux spécialités du référentiel s'écrivent ainsi — fusionnez-les" : "absente du référentiel");
    parts.push(`à rattacher à la main : ${liste.slice(0, 6).map(([n, r]) => `« ${n} » (${raison(r)})`).join(", ")}${liste.length > 6 ? ` et ${liste.length - 6} autre(s)` : ""}`);
  }
  return { ok: true, rattachees, message: parts.join(" · ") };
}

/**
 * ÉCRITURE D'UNE CELLULE SUR MESURE — les colonnes propres à un annuaire, enfin dans la feuille.
 *
 * `MedicalDirectoryColumn` existait, l'import savait les remplir, Adam savait les créer — et
 * AUCUN écran ne les affichait ni ne les éditait (§118.14). La valeur vit dans
 * `MedicalDoctor.custom` sous la clé FIGÉE de la colonne ; on la valide selon le TYPE que la
 * colonne déclare : un nombre reste un nombre (« 12,5 » accepté, « douze » refusé), une date une
 * date ISO, un choix une des options. Un texte vide EFFACE la clé — une cellule effacée est une
 * absence, pas une chaîne vide.
 *
 * Même garde que le tronc commun : la ligne doit être à la portée de la personne, et la colonne
 * doit appartenir à l'annuaire de CETTE fiche — écrire la clé d'un autre annuaire fabriquerait
 * une valeur qu'aucune feuille n'affiche.
 */
export async function saveDirectoryCustomCell(input: { id: string; key: string; value: string }): Promise<ActionResult> {
  const user = await requireUser();
  const id = String(input.id ?? "").trim();
  const key = String(input.key ?? "").trim();
  if (!id) return { ok: false, error: "Fiche introuvable." };
  if (!key) return { ok: false, error: "Colonne inconnue." };
  if (!(await canAccessEntity(user, "DOCTOR", id, "UPDATE"))) return { ok: false, error: "Non autorisé à modifier cette fiche." };

  const doctor = await prisma.medicalDoctor.findUnique({ where: { id }, select: { directoryId: true, custom: true } });
  if (!doctor) return { ok: false, error: "Fiche introuvable." };
  if (!doctor.directoryId) return { ok: false, error: "Cette fiche est dans l'annuaire général, qui n'a pas de colonne sur mesure." };
  const col = await prisma.medicalDirectoryColumn.findUnique({
    where: { directoryId_key: { directoryId: doctor.directoryId, key } },
    select: { kind: true, options: true, label: true },
  });
  if (!col) return { ok: false, error: "Cette colonne n'appartient pas à l'annuaire de la fiche." };

  const raw = String(input.value ?? "").replace(/\s+/g, " ").trim();
  let value: string | number | null = null;
  if (raw) {
    switch (col.kind) {
      case "NUMBER": {
        const n = Number(raw.replace(/\s/g, "").replace(",", "."));
        if (!Number.isFinite(n)) return { ok: false, error: `« ${col.label} » attend un nombre.` };
        value = n;
        break;
      }
      case "DATE": {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(raw))) {
          return { ok: false, error: `« ${col.label} » attend une date (AAAA-MM-JJ).` };
        }
        value = raw;
        break;
      }
      case "CHOICE": {
        const options = (col.options ?? "").split("|").map((o) => o.trim()).filter(Boolean);
        if (!options.includes(raw)) return { ok: false, error: `« ${col.label} » n'accepte que : ${options.join(", ")}.` };
        value = raw;
        break;
      }
      default:
        value = raw;
    }
  }

  const base = (doctor.custom && typeof doctor.custom === "object" && !Array.isArray(doctor.custom)
    ? doctor.custom
    : {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...base };
  if (value === null) delete next[key]; else next[key] = value;

  await prisma.medicalDoctor.update({ where: { id }, data: { custom: next as Prisma.InputJsonObject, updatedById: user.id } });
  revalidatePath("/medical/annuaire");
  revalidatePath("/annuaires");
  return { ok: true };
}

/**
 * AJOUTER UNE LIGNE — un praticien de plus dans la feuille.
 *
 * Un annuaire vivant se complète à la main, pas seulement par import. On exige au moins un nom
 * (une fiche sans nom n'est pas une fiche) ; le reste se remplit ensuite, cellule par cellule.
 */
export async function addDirectoryDoctor(input: {
  lastName: string; firstName: string; specialty: string; wilaya: string;
  /** Le grade à la création — l'onglet « Pharmaciens » crée un PHARMACIEN, les autres laissent le défaut. */
  title?: string;
  /** L'annuaire nommé dans lequel ranger la fiche ; absent = l'annuaire général. */
  directoryId?: string | null;
  /** L'établissement de l'annuaire des établissements (§118.172) — choisi, jamais tapé. */
  institutionId?: string | null;
  /** Son service — toujours un service DE cet établissement. */
  serviceId?: string | null;
}): Promise<ActionResult> {
  const user = await requireUser();
  // LE GRADE D'ABORD : c'est lui qui range la fiche dans l'annuaire des médecins ou des
  // pharmaciens, donc lui qui dit quel droit s'applique (§118.147). Lire le droit avant lui
  // jugerait la création d'un pharmacien sur l'annuaire des médecins.
  const title = input.title ? validateAnnuaireValue("title", input.title) : null;
  if (title && !title.ok) return { ok: false, error: title.error };
  const annuaire = annuaireDuPraticien(title && title.ok ? title.value : null);
  if (!peutAnnuaire(user, annuaire, "CREATE")) {
    return { ok: false, error: `Non autorisé à alimenter l'annuaire des ${annuaire === "PHARMACIENS" ? "pharmaciens" : "médecins"} (Promotion médicale, ou accès ouvert depuis Administration › Comptes).` };
  }
  const directoryId = input.directoryId ? String(input.directoryId) : null;
  if (directoryId) {
    const dir = await prisma.medicalDirectory.findUnique({ where: { id: directoryId }, select: { id: true } });
    if (!dir) return { ok: false, error: "Annuaire introuvable." };
  }

  const lastName = input.lastName.replace(/\s+/g, " ").trim();
  const firstName = input.firstName.replace(/\s+/g, " ").trim();
  const name = composeDoctorName(firstName, lastName);
  if (!name) return { ok: false, error: "Le nom (ou le prénom) est obligatoire." };

  const wilaya = validateAnnuaireValue("wilaya", input.wilaya);
  if (!wilaya.ok) return { ok: false, error: wilaya.error };
  // La spécialité saisie se RÉSOUT (§118.180) : un lien quand elle désigne une spécialité du
  // référentiel à coup sûr, le texte tel quel sinon.
  const specialite = ecritureDeSpecialite(
    input.specialty,
    indexerSpecialites(await prisma.medicalSpecialty.findMany({ select: { id: true, name: true } })),
  );

  // L'ÉTABLISSEMENT ET LE SERVICE — les mêmes règles que la cellule de la feuille : un
  // établissement ACTIF de l'annuaire, et un service qui lui appartient.
  const institutionId = input.institutionId ? String(input.institutionId).trim() || null : null;
  const serviceId = input.serviceId ? String(input.serviceId).trim() || null : null;
  let institution: string | null = null;
  if (institutionId) {
    const etab = await prisma.medicalInstitution.findUnique({ where: { id: institutionId }, select: { name: true, isActive: true } });
    if (!etab) return { ok: false, error: "Cet établissement n'existe pas (ou plus) dans l'annuaire des établissements." };
    if (!etab.isActive) return { ok: false, error: `« ${etab.name} » est désactivé dans l'annuaire des établissements : réactivez-le d'abord, ou choisissez-en un autre.` };
    institution = etab.name;
  }
  if (serviceId) {
    if (!institutionId) return { ok: false, error: "Un service se choisit dans un établissement : choisissez d'abord l'établissement." };
    const service = await prisma.medicalInstitutionService.findUnique({ where: { id: serviceId }, select: { institutionId: true } });
    if (!service || service.institutionId !== institutionId) return { ok: false, error: "Ce service n'appartient pas à l'établissement choisi." };
  }

  // Un délégué est propriétaire des fiches qu'il crée (portée au niveau ligne).
  const delegateId = user.role === "MEDICAL_DELEGATE" ? user.id : null;
  const companyId = await companyIdForNew(user.id);

  // DOUBLE ÉCRITURE (refonte, lot V2-B) : la Personne dans la même transaction, derrière son interrupteur.
  const created = await prisma.$transaction(async (tx) => {
    const ligne = await tx.medicalDoctor.create({
      data: {
        name, lastName: lastName || null, firstName: firstName || null,
        specialty: specialite.specialty, specialtyId: specialite.specialtyId, wilaya: wilaya.value, delegateId, companyId, directoryId,
        institutionId, institution, serviceId,
        ...(title && title.ok && title.value ? { title: title.value as never } : {}),
        createdById: user.id, updatedById: user.id,
      },
      select: { id: true },
    });
    await relierALaPersonne(tx, "MedicalDoctor", ligne.id, user.id);
    return ligne;
  });
  // Établissement déduit de la wilaya et de la spécialité, service = spécialité (Direction, 06/10).
  await completerRattachement([created.id], user.id);
  await reposerWilayaCode("MedicalDoctor", created.id); // double écriture des lieux (V2-D)
  await recordAudit({
    actorId: user.id, action: "CREATE", module: "Promotion médicale",
    entityType: "DOCTOR", entityId: created.id, summary: `Annuaire — fiche « ${name} »`,
  });
  revalidatePath("/medical/annuaire");
  revalidatePath("/medical");
  return { ok: true, id: created.id };
}

/**
 * SUPPRIMER DES FICHES DE L'ANNUAIRE — une, ou plusieurs d'un coup.
 *
 * Un annuaire se nettoie par lots : des doublons d'import, un cabinet fermé, une liste
 * périmée. Les supprimer une par une, personne ne le fait — on garde alors des fiches fausses,
 * ce qui est pire qu'une fiche manquante.
 *
 * Chaque ligne est revérifiée INDIVIDUELLEMENT : un délégué ne supprime que ses praticiens, et
 * une sélection qui déborde ne supprime que ce qu'elle avait le droit de supprimer — jamais
 * tout ou rien, jamais plus que le droit.
 */
export async function deleteDirectoryDoctors(ids: string[]): Promise<ActionResult> {
  const user = await requireUser();
  // La porte : l'un des deux annuaires de praticiens en suppression (§118.147). Elle ne suffit
  // pas — chaque ligne est revérifiée plus bas, dans l'annuaire de SON grade : ouvrir l'annuaire
  // des médecins ne fait pas supprimer un pharmacien pris dans la même sélection.
  if (!peutAnnuaire(user, "MEDECINS", "DELETE") && !peutAnnuaire(user, "PHARMACIENS", "DELETE")) {
    return { ok: false, error: "Suppression réservée (droit Supprimer sur l'annuaire des praticiens)." };
  }
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return { ok: false, error: "Aucune ligne sélectionnée." };

  const allowed: string[] = [];
  for (const id of unique) {
    if (await canAccessEntity(user, "DOCTOR", id, "DELETE")) allowed.push(id);
  }
  if (allowed.length === 0) return { ok: false, error: "Aucune de ces fiches ne vous appartient." };

  // ARCHIVAGE RÉVERSIBLE (Direction, 06/10) : « supprimer » une ligne l'ARCHIVE. La fiche garde ses
  // visites, son historique et ses couleurs ; elle sort de la feuille, des comptes, de l'export et
  // de la recherche, et revient par `restaurerDirectoryDoctors` depuis la vue « Archivés ».
  const { count } = await prisma.medicalDoctor.updateMany({
    where: { id: { in: allowed }, archivedAt: null },
    data: { archivedAt: new Date(), archivedById: user.id },
  });
  await recordAudit({
    actorId: user.id, action: "DELETE", module: "Promotion médicale",
    summary: `Annuaire — ${count} fiche(s) archivée(s) (restaurables)`,
  });
  revalidatePath("/medical/annuaire");
  revalidatePath("/medical");
  revalidatePath("/annuaires/medecins");
  revalidatePath("/annuaires/pharmaciens");

  const skipped = unique.length - allowed.length;
  return {
    ok: true,
    message: skipped > 0
      ? `${count} fiche(s) archivée(s) · ${skipped} hors de votre portée, laissée(s) en place`
      : `${count} fiche(s) archivée(s) — restaurables depuis « Archivés »`,
  };
}

/**
 * RESTAURER DES FICHES ARCHIVÉES — le retour de `deleteDirectoryDoctors`. Même porte (le droit
 * Supprimer d'un des deux annuaires de praticiens) et même revérification ligne par ligne : qui
 * peut archiver une fiche peut la ramener, personne d'autre.
 */
export async function restaurerDirectoryDoctors(ids: string[]): Promise<ActionResult> {
  const user = await requireUser();
  if (!peutAnnuaire(user, "MEDECINS", "DELETE") && !peutAnnuaire(user, "PHARMACIENS", "DELETE")) {
    return { ok: false, error: "Restauration réservée (droit Supprimer sur l'annuaire des praticiens)." };
  }
  const unique = [...new Set(ids.filter(Boolean))];
  if (unique.length === 0) return { ok: false, error: "Aucune ligne sélectionnée." };

  const allowed: string[] = [];
  for (const id of unique) {
    if (await canAccessEntity(user, "DOCTOR", id, "DELETE")) allowed.push(id);
  }
  if (allowed.length === 0) return { ok: false, error: "Aucune de ces fiches ne vous appartient." };

  const { count } = await prisma.medicalDoctor.updateMany({
    where: { id: { in: allowed }, archivedAt: { not: null } },
    data: { archivedAt: null, archivedById: null },
  });
  await recordAudit({
    actorId: user.id, action: "UPDATE", module: "Promotion médicale",
    summary: `Annuaire — ${count} fiche(s) restaurée(s)`,
  });
  revalidatePath("/medical/annuaire");
  revalidatePath("/medical");
  revalidatePath("/annuaires/medecins");
  revalidatePath("/annuaires/pharmaciens");
  return { ok: true, message: `${count} fiche(s) restaurée(s)` };
}
