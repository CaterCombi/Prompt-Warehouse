export type AssetRegisterSource = {
  assetNumber: string;
  manufacturer: string | null;
  model: string | null;
  fuel: string | null;
  size: string | null;
};

export type EngineerReportAssetDetails = {
  manufacturer: string | null;
  model: string | null;
  powerSource: string | null;
  size: string | null;
};

function normalizedAssetNumber(value: string): string {
  return value.trim().toLocaleLowerCase("en-GB");
}

function sourceText(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

export function findEngineerReportAssetSource(
  records: readonly AssetRegisterSource[],
  assetNumber: string,
): AssetRegisterSource | null {
  const normalizedAsset = normalizedAssetNumber(assetNumber);
  const matches = records.filter(
    (record) => normalizedAssetNumber(record.assetNumber) === normalizedAsset,
  );
  if (matches.length > 1) {
    throw new Error(`More than one asset-register record matches asset ${assetNumber}.`);
  }
  return matches[0] ?? null;
}

export function toEngineerReportAssetDetails(
  record: AssetRegisterSource | null,
): EngineerReportAssetDetails {
  return {
    manufacturer: sourceText(record?.manufacturer),
    model: sourceText(record?.model),
    powerSource: sourceText(record?.fuel),
    size: sourceText(record?.size),
  };
}

export function reconcileEngineerReportValue(
  label: string,
  serviceValue: string | null,
  registerValue: string | null,
  warnings: string[],
): string | null {
  const service = sourceText(serviceValue);
  const register = sourceText(registerValue);
  if (service && register && service.toLocaleLowerCase("en-GB") !== register.toLocaleLowerCase("en-GB")) {
    warnings.push(
      `${label} differs between the selected refurbishment record ("${service}") and asset register ("${register}"); review before sign-off.`,
    );
  }
  return register ?? service;
}