"""Initial schema: players, progress, level results, hint usage.

Revision ID: 0001
Revises:
Create Date: 2026-10-28
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0001"
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "players",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("key_hash", sa.LargeBinary(32), nullable=False, unique=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column(
            "last_active", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
    )
    op.create_table(
        "game_progress",
        sa.Column(
            "player_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("players.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("game_id", sa.String(32), primary_key=True),
        sa.Column("unlocked_level", sa.Integer(), nullable=False),
        sa.CheckConstraint("unlocked_level BETWEEN 1 AND 10000", name="unlocked_range"),
    )
    op.create_table(
        "level_results",
        sa.Column(
            "player_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("players.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("game_id", sa.String(32), primary_key=True),
        sa.Column("level", sa.Integer(), primary_key=True),
        sa.Column("stars", sa.SmallInteger(), nullable=False),
        sa.Column("best_moves", sa.Integer(), nullable=True),
        sa.Column(
            "completed_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint("stars BETWEEN 1 AND 3", name="stars_range"),
    )
    op.create_table(
        "hint_usage",
        sa.Column(
            "player_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("players.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("game_id", sa.String(32), primary_key=True),
        sa.Column("day_utc", sa.Date(), primary_key=True),
        sa.Column("used", sa.SmallInteger(), nullable=False),
        sa.CheckConstraint("used >= 0", name="used_non_negative"),
    )


def downgrade() -> None:
    op.drop_table("hint_usage")
    op.drop_table("level_results")
    op.drop_table("game_progress")
    op.drop_table("players")
