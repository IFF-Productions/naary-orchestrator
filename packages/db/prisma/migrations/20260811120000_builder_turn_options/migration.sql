-- AI-builder structured quick-reply options (#487): the assistant turn carries a
-- short set of tappable "next step" suggestions; user turns keep the default empty array.
ALTER TABLE "BuilderTurn" ADD COLUMN "options" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
