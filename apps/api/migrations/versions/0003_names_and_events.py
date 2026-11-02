"""Display names, and first-party play events for analytics.

Revision ID: 0003
Revises: 0002
Create Date: 2026-11-02
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003"
down_revision: str | None = "0002"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("players", sa.Column("display_name", sa.String(20), nullable=True))
    op.create_table(
        "play_events",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("day", sa.Date(), server_default=sa.text("CURRENT_DATE"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("game_id", sa.String(32), nullable=True),
        sa.Column("level", sa.Integer(), nullable=True),
        sa.Column("who", sa.String(16), nullable=False),
        sa.Column("signed_in", sa.Boolean(), nullable=False),
        sa.Column("stars", sa.SmallInteger(), nullable=True),
        sa.Column("coins", sa.Integer(), nullable=True),
        sa.Column("detail", sa.String(32), nullable=True),
    )
    op.create_index("ix_play_events_day_game", "play_events", ["day", "game_id"])
    op.create_index("ix_play_events_game_level", "play_events", ["game_id", "level", "kind"])


def downgrade() -> None:
    op.drop_index("ix_play_events_game_level", table_name="play_events")
    op.drop_index("ix_play_events_day_game", table_name="play_events")
    op.drop_table("play_events")
    op.drop_column("players", "display_name")
