import { NextResponse } from 'next/server';
import { isSetupComplete } from '@/lib/settings-store';

// Lightweight endpoint called by middleware to check if a user has
// registered. No auth required — must be accessible before login exists.
export async function GET() {
  return NextResponse.json({ registered: isSetupComplete() });
}
