"use client";
import dynamic from 'next/dynamic';
import AdvancedEditorGate from '@/components/routing-workbench/AdvancedEditorGate';
const AtomicToolsConsole = dynamic(() => import('../LegacyToolsShell'), {ssr:false});
export default function AdvancedPage() {return <AdvancedEditorGate feature="tools"><AtomicToolsConsole /></AdvancedEditorGate>;}
