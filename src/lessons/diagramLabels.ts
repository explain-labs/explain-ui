import type { L10n } from "@/lessons/i18n";

// Default captions for diagram component/connector names, shown when a lesson
// step highlights them (connectors carry no caption of their own). Names are
// the diagram_definition component keys of the neonatal scenarios. A step's
// `diagramLabels` overrides these.
export const DIAGRAM_LABELS: Record<string, L10n> = {
  // heart
  LA: { nl: "Linkeratrium", en: "Left atrium" },
  RA: { nl: "Rechteratrium", en: "Right atrium" },
  LV: { nl: "Linkerventrikel", en: "Left ventricle" },
  RV: { nl: "Rechterventrikel", en: "Right ventricle" },
  // great arteries + lungs
  AA: { nl: "Aorta ascendens", en: "Ascending aorta" },
  AAR: { nl: "Aortaboog", en: "Aortic arch" },
  AD: { nl: "Aorta descendens", en: "Descending aorta" },
  PA: { nl: "A. pulmonalis", en: "Pulmonary artery" },
  LPA: { nl: "Linker a. pulmonalis", en: "Left pulmonary artery" },
  RPA: { nl: "Rechter a. pulmonalis", en: "Right pulmonary artery" },
  LL: { nl: "Linkerlong", en: "Left lung" },
  RL: { nl: "Rechterlong", en: "Right lung" },
  PV: { nl: "Longvenen", en: "Pulmonary veins" },
  SVC: { nl: "V. cava superior", en: "Superior vena cava" },
  IVCI: { nl: "V. cava inferior", en: "Inferior vena cava" },
  // valves
  LA_LV: { nl: "Mitralisklep", en: "Mitral valve" },
  RA_RV: { nl: "Tricuspidalisklep", en: "Tricuspid valve" },
  LV_AA: { nl: "Aortaklep", en: "Aortic valve" },
  RV_PA: { nl: "Pulmonalisklep", en: "Pulmonary valve" },
  // shunts
  DA: { nl: "Ductus arteriosus", en: "Ductus arteriosus" },
  FO: { nl: "Foramen ovale", en: "Foramen ovale" },
  VSD: { nl: "VSD", en: "VSD" },
};
