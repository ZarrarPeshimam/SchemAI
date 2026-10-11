import React, { useState } from 'react';
import { 
  Table, 
  GitFork, 
  CheckCircle2, 
  Key, 
  Link2, 
  ShieldCheck,
  AlertCircle,
  AlertTriangle
} from 'lucide-react';
import { MOCK_VALIDATIONS } from '../data/mockSchema';
import { describeRelationshipKey, getEntity } from '../utils/schemaHelpers';

export default function SchemaPanel({ schema, selectedEntityId, onSelectEntity, validationData }) {
  const [activeTab, setActiveTab] = useState('entities');
  const entities = schema?.entities || [];
  const relationships = schema?.relationships || [];

  const checksPassedCount = validationData?.summary
    ? `${validationData.summary.checksPassed}/${validationData.summary.totalChecks}`
    : `${MOCK_VALIDATIONS.length}/${MOCK_VALIDATIONS.length}`;

  const tabs = [
    { id: 'entities', label: 'Entities', count: entities.length, icon: Table },
    { id: 'relationships', label: 'Relationships', count: relationships.length, icon: GitFork },
    { id: 'validation', label: 'Validation', count: checksPassedCount, icon: ShieldCheck },
  ];

  return (
    <div className="bg-dark-900 border border-dark-750 rounded-lg flex flex-col shadow-sm overflow-hidden">
      {/* Panel Header & Tabs */}
      <div className="px-4 py-2 border-b border-dark-750 bg-dark-850/80 flex items-center justify-between select-none">
        <div className="flex items-center space-x-1 sm:space-x-2">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center space-x-2 px-3 py-1.5 rounded-md text-xs font-medium transition-all ${
                  isActive
                    ? 'bg-dark-800 text-brand-500 border border-dark-700 shadow-sm font-semibold'
                    : 'text-dark-400 hover:text-dark-200 hover:bg-dark-800/60'
                }`}
              >
                <Icon className={`w-3.5 h-3.5 ${isActive ? 'text-brand-500' : 'text-dark-400'}`} />
                <span>{tab.label}</span>
                <span className={`text-[10px] px-1.5 py-0.2 rounded font-mono ${
                  isActive ? 'bg-brand-600/20 text-brand-400' : 'bg-dark-800 text-dark-500'
                }`}>
                  {tab.count}
                </span>
              </button>
            );
          })}
        </div>

        <div className="text-[11px] font-mono text-dark-400 hidden sm:block">
          PostgreSQL / Relational
        </div>
      </div>

      {/* Tab Contents */}
      <div className="p-3">
        {/* 1. ENTITIES TAB */}
        {activeTab === 'entities' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-2.5">
            {entities.map((entity) => {
              const isExpanded = selectedEntityId === entity.id;
              return (
                <div
                  key={entity.id}
                  onClick={() => onSelectEntity(isExpanded ? null : entity.id)}
                  className={`bg-dark-950/80 border rounded-md p-3 transition-colors cursor-pointer flex flex-col justify-between group ${
                    isExpanded 
                      ? 'border-brand-500/50 bg-dark-950' 
                      : 'border-dark-750 hover:border-dark-600 hover:bg-dark-850/50'
                  }`}
                >
                  <div className="flex items-center justify-between mb-2">
                    <span className="font-semibold text-xs text-dark-100 group-hover:text-brand-400 transition-colors">
                      {entity.name}
                    </span>
                    <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-dark-850 text-dark-400 border border-dark-750">
                      {entity.attributes.length} attr
                    </span>
                  </div>

                  {/* Attributes list */}
                  <div className="space-y-1 font-mono text-[11px]">
                    {entity.attributes.map((attr) => (
                      <div key={attr.name} className="flex items-center justify-between text-dark-300">
                        <div className="flex items-center space-x-1.5 truncate">
                          {attr.primaryKey ? (
                            <span className="text-[9px] px-1 py-0.2 rounded bg-amber-500/20 text-amber-400 font-bold border border-amber-500/30">
                              PK
                            </span>
                          ) : attr.foreignKey ? (
                            <span className="text-[9px] px-1 py-0.2 rounded bg-blue-500/20 text-blue-400 font-bold border border-blue-500/30">
                              FK
                            </span>
                          ) : (
                            <span className="w-1.5 h-1.5 rounded-full bg-dark-600 ml-1"></span>
                          )}
                          <span className="truncate">{attr.name}</span>
                        </div>
                        <span className="text-[10px] text-dark-500 ml-2">{attr.type}</span>
                      </div>
                    ))}
                  </div>

                  <div className="mt-2.5 pt-2 border-t border-dark-800 text-[10px] text-dark-500 truncate">
                    {entity.description}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* 2. RELATIONSHIPS TAB */}
        {activeTab === 'relationships' && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-2.5">
            {relationships.map((rel) => (
              <div
                key={rel.id}
                className={`bg-dark-950/80 border rounded-md p-3 flex flex-col justify-between transition-colors ${
                  selectedEntityId && (rel.source === selectedEntityId || rel.target === selectedEntityId)
                    ? 'border-brand-500/50'
                    : 'border-dark-750 hover:border-dark-600'
                }`}
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-brand-500/10 text-brand-400 border border-brand-500/30 font-semibold">
                      {rel.cardinality}
                    </span>
                    <span className="text-[11px] font-mono text-dark-400 italic">
                      "{rel.name}"
                    </span>
                  </div>

                  <div className="flex items-center space-x-2 my-2 text-xs font-semibold text-dark-100">
                    <span className="px-2 py-1 rounded bg-dark-850 border border-dark-700 text-dark-200">
                      {getEntity(schema, rel.source)?.name}
                    </span>
                    <span className="text-dark-500 text-xs">→</span>
                    <span className="px-2 py-1 rounded bg-dark-850 border border-dark-700 text-dark-200">
                      {getEntity(schema, rel.target)?.name}
                    </span>
                  </div>
                </div>

                <div className="mt-2 pt-2 border-t border-dark-800 flex items-center space-x-1.5 text-[10px] font-mono text-dark-400 truncate">
                  <Link2 className="w-3 h-3 text-dark-500 shrink-0" />
                  <span className="truncate">{describeRelationshipKey(schema, rel)}</span>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 3. VALIDATION TAB */}
        {activeTab === 'validation' && (
          <div className="space-y-3">
            {validationData?.errors?.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-rose-400 flex items-center space-x-1.5">
                  <AlertCircle className="w-3.5 h-3.5" />
                  <span>Validation Errors ({validationData.errors.length})</span>
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {validationData.errors.map((err, idx) => (
                    <div key={idx} className="bg-rose-950/20 border border-rose-900/40 rounded-md p-2.5 text-xs">
                      <div className="font-semibold text-rose-300 font-mono text-[11px]">{err.code}</div>
                      <div className="text-dark-300 text-[11px] mt-1">{err.message}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {validationData?.warnings?.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-xs font-semibold text-amber-400 flex items-center space-x-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>Validation Warnings ({validationData.warnings.length})</span>
                </h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  {validationData.warnings.map((warn, idx) => (
                    <div key={idx} className="bg-amber-950/20 border border-amber-900/40 rounded-md p-2.5 text-xs">
                      <div className="font-semibold text-amber-300 font-mono text-[11px]">{warn.code}</div>
                      <div className="text-dark-300 text-[11px] mt-1">{warn.message}</div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2.5">
              {MOCK_VALIDATIONS.map((val) => (
                <div
                  key={val.id}
                  className="bg-dark-950/80 border border-dark-750 rounded-md p-3 flex flex-col justify-between hover:border-emerald-500/40 transition-colors"
                >
                  <div className="flex items-start space-x-2.5 mb-2">
                    <div className="p-1 rounded bg-emerald-500/10 text-emerald-400 shrink-0 mt-0.5">
                      <CheckCircle2 className="w-4 h-4" />
                    </div>
                    <div>
                      <h4 className="text-xs font-medium text-dark-100 leading-snug">
                        {val.message}
                      </h4>
                      <p className="text-[10px] text-dark-400 mt-1">
                        {val.details}
                      </p>
                    </div>
                  </div>

                  <div className="mt-2 pt-2 border-t border-dark-800 flex items-center justify-between text-[10px] font-mono">
                    <span className="text-dark-500">{val.rule}</span>
                    <span className="text-emerald-400 font-medium">Passed</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
