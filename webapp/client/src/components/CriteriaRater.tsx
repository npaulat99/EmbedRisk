import type { RiskAxisLevel, RiskCriterion } from '../types';

export default function CriteriaRater({
    criteria,
    levels,
    values,
    onChange,
    disabled = false,
}: {
    criteria: RiskCriterion[];
    levels: RiskAxisLevel[];
    values: Record<string, number | null | undefined>;
    onChange: (criterionId: string, value: number | null) => void;
    disabled?: boolean;
}) {
    return (
        <div className="settings-weight-grid">
            {criteria.map((criterion) => {
                const value = values[criterion.id];
                const description = typeof value === 'number' ? criterion.levelTexts[String(value)] : null;
                return (
                    <label className="minifield" key={criterion.id}>
                        <span>{criterion.label}</span>
                        <select
                            className="inp"
                            value={value ?? ''}
                            disabled={disabled}
                            aria-label={criterion.label}
                            onChange={(event) => onChange(criterion.id, event.target.value === '' ? null : Number(event.target.value))}
                        >
                            <option value="">Not assessed / not relevant</option>
                            {levels.map((level) => (
                                <option key={level.value} value={level.value}>
                                    {level.code} · {level.label}
                                </option>
                            ))}
                        </select>
                        {description && <span className="hint">{description}</span>}
                    </label>
                );
            })}
        </div>
    );
}
