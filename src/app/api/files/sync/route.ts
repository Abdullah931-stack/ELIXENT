/**
 * Sync API Route
 * 
 * GET /api/files/sync - Fetch files updated after a timestamp
 * Supports pagination and rate limiting
 */

import { NextRequest, NextResponse } from 'next/server';
import { db, schema } from '@/server/db';
import { getUser } from '@/lib/supabase/server';
import { eq, and, gt, isNull, or } from 'drizzle-orm';
import {
    syncApiRateLimiter,
    addRateLimitHeaders,
    rateLimitExceededResponse
} from '@/lib/rate-limit';
import { getOrGenerateCorrelationId, addCorrelationHeader } from '@/lib/utils/correlation';
import { syncPullRequestSchema } from '@/types/sync-contracts';
import { createProblemDetails } from '@/types/problem-details';

export const dynamic = 'force-dynamic';

/**
 * Default and maximum page sizes
 */
const DEFAULT_LIMIT = 50;

/**
 * GET /api/files/sync
 * 
 * Query Parameters:
 * - updated_after: ISO timestamp to fetch updates after
 * - limit: Number of files to return (max 100)
 * - cursor: Pagination cursor for next page
 * 
 * Response:
 * - files: Array of file objects with sync metadata
 * - has_more: Whether more files are available
 * - next_cursor: Cursor for next page (if has_more is true)
 */
export async function GET(request: NextRequest) {
    const correlationId = getOrGenerateCorrelationId(request);
    try {
        // Authenticate user
        const user = await getUser();
        if (!user) {
            const res = NextResponse.json(
                { error: 'Authentication required', correlationId },
                { status: 401 }
            );
            addCorrelationHeader(res.headers, correlationId);
            return res;
        }

        // Apply rate limiting
        const rateLimitResult = await syncApiRateLimiter.limit(user.id);
        if (!rateLimitResult.success) {
            const res = rateLimitExceededResponse(rateLimitResult);
            addCorrelationHeader(res.headers, correlationId);
            return res;
        }

        // Parse query parameters
        const { searchParams } = new URL(request.url);
        const updatedAfterRaw = searchParams.get('updatedAfter') || searchParams.get('updated_after');
        const limitRaw = searchParams.get('limit');
        const cursorRaw = searchParams.get('cursor');

        const pullParams: Record<string, unknown> = {};
        if (updatedAfterRaw) pullParams.updatedAfter = updatedAfterRaw;
        if (cursorRaw) pullParams.cursor = cursorRaw;
        if (limitRaw !== null) {
            const parsedNum = Number(limitRaw);
            pullParams.limit = isNaN(parsedNum) ? limitRaw : parsedNum;
        }

        const pullParsed = syncPullRequestSchema.safeParse(pullParams);
        if (!pullParsed.success) {
            const problem = createProblemDetails({
                type: 'urn:problem-type:invalid-sync-pull-request',
                title: 'Invalid Sync Pull Request',
                status: 400,
                detail: pullParsed.error.issues.map(i => i.message).join(', '),
                instance: '/api/files/sync',
                correlationId,
            });
            const res = new NextResponse(JSON.stringify(problem), {
                status: 400,
                headers: { 'Content-Type': 'application/problem+json' },
            });
            addCorrelationHeader(res.headers, correlationId);
            return res;
        }

        // Parse updated_after timestamp
        const updatedAfter = pullParsed.data.updatedAfter ? new Date(pullParsed.data.updatedAfter) : null;

        // Parse limit with bounds
        const limit = pullParsed.data.limit ?? DEFAULT_LIMIT;
        const cursor = pullParsed.data.cursor;

        // Build query conditions
        const conditions = [
            eq(schema.files.userId, user.id),
            // Exclude soft-deleted files unless they were deleted after updatedAfter
            or(
                isNull(schema.files.deletedAt),
                updatedAfter ? gt(schema.files.deletedAt, updatedAfter) : undefined
            ),
        ].filter(Boolean);

        // Add updated_after condition
        if (updatedAfter) {
            conditions.push(gt(schema.files.updatedAt, updatedAfter));
        }

        // Add cursor condition for pagination
        if (cursor) {
            try {
                const cursorData = JSON.parse(Buffer.from(cursor, 'base64').toString());
                if (cursorData && typeof cursorData.id === 'string' && cursorData.updatedAt) {
                    const cursorDate = new Date(cursorData.updatedAt);
                    if (!isNaN(cursorDate.getTime())) {
                        conditions.push(
                            or(
                                gt(schema.files.updatedAt, cursorDate),
                                and(
                                    eq(schema.files.updatedAt, cursorDate),
                                    gt(schema.files.id, cursorData.id)
                                )
                            )!
                        );
                    }
                }
            } catch {
                // Invalid cursor, ignore
            }
        }

        // Fetch files with limit + 1 to check for more
        const files = await db.query.files.findMany({
            where: and(...conditions),
            orderBy: (files, { asc }) => [asc(files.updatedAt), asc(files.id)],
            limit: limit + 1,
        });

        // Check if there are more results
        const hasMore = files.length > limit;
        const resultFiles = hasMore ? files.slice(0, limit) : files;

        // Generate next cursor if there are more results
        let nextCursor: string | null = null;
        if (hasMore && resultFiles.length > 0) {
            const lastFile = resultFiles[resultFiles.length - 1];
            const cursorData = {
                updatedAt: lastFile.updatedAt.toISOString(),
                id: lastFile.id,
            };
            nextCursor = Buffer.from(JSON.stringify(cursorData)).toString('base64');
        }

        // Format response
        const responseFiles = resultFiles.map(file => ({
            id: file.id,
            title: file.title,
            content: file.content,
            isEncrypted: file.isEncrypted,
            encryptionMetadata: file.encryptionMetadata,
            etag: file.etag,
            version: file.version,
            parentFolderId: file.parentFolderId,
            isFolder: file.isFolder,
            deletedAt: file.deletedAt?.toISOString() || null,
            updatedAt: file.updatedAt.toISOString(),
            createdAt: file.createdAt.toISOString(),
        }));

        // Build response with rate limit headers
        const responseHeaders = new Headers({
            'Content-Type': 'application/json',
            'Cache-Control': 'private, no-cache, no-store, must-revalidate',
        });
        addRateLimitHeaders(responseHeaders, rateLimitResult);
        addCorrelationHeader(responseHeaders, correlationId);

        return new Response(
            JSON.stringify({
                files: responseFiles,
                has_more: hasMore,
                next_cursor: nextCursor,
                sync_timestamp: new Date().toISOString(),
            }),
            {
                status: 200,
                headers: responseHeaders,
            }
        );

    } catch (error) {
        console.error('[Sync API] Error:', error);
        const res = NextResponse.json(
            { error: 'Internal server error', correlationId },
            { status: 500 }
        );
        addCorrelationHeader(res.headers, correlationId);
        return res;
    }
}
