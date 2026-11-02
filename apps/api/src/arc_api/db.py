"""Database models and session factory (PostgreSQL via asyncpg)."""

from __future__ import annotations

import uuid
from collections.abc import AsyncIterator
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    LargeBinary,
    SmallInteger,
    String,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.schema import Index


class Base(DeclarativeBase):
    pass


class Player(Base):
    __tablename__ = "players"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # HMAC(pepper, recovery key). The key itself is never stored.
    key_hash: Mapped[bytes] = mapped_column(LargeBinary(32), unique=True, nullable=False)
    # Optional, not unique, checked for profanity (arc_api.names).
    display_name: Mapped[str | None] = mapped_column(String(20))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    last_active: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class GameProgress(Base):
    __tablename__ = "game_progress"
    __table_args__ = (CheckConstraint("unlocked_level BETWEEN 1 AND 10000", name="unlocked_range"),)

    player_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("players.id", ondelete="CASCADE"), primary_key=True
    )
    game_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    unlocked_level: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    # First clears in a row without assists; resets after each streak bonus.
    streak: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0, server_default="0")


class LevelResult(Base):
    __tablename__ = "level_results"
    __table_args__ = (CheckConstraint("stars BETWEEN 1 AND 3", name="stars_range"),)

    player_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("players.id", ondelete="CASCADE"), primary_key=True
    )
    game_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    level: Mapped[int] = mapped_column(Integer, primary_key=True)
    stars: Mapped[int] = mapped_column(SmallInteger, nullable=False)
    best_moves: Mapped[int | None] = mapped_column(Integer)
    completed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class HintUsage(Base):
    __tablename__ = "hint_usage"
    __table_args__ = (CheckConstraint("used >= 0", name="used_non_negative"),)

    player_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("players.id", ondelete="CASCADE"), primary_key=True
    )
    game_id: Mapped[str] = mapped_column(String(32), primary_key=True)
    day_utc: Mapped[date] = mapped_column(Date, primary_key=True)
    used: Mapped[int] = mapped_column(SmallInteger, nullable=False, default=0)


class Wallet(Base):
    """One coin balance per player, shared by every game."""

    __tablename__ = "wallets"
    __table_args__ = (CheckConstraint("balance >= 0", name="balance_non_negative"),)

    player_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("players.id", ondelete="CASCADE"), primary_key=True
    )
    balance: Mapped[int] = mapped_column(Integer, nullable=False)


class CoinLedger(Base):
    """Every coin change, so a balance can always be explained."""

    __tablename__ = "coin_ledger"
    __table_args__ = (
        # A level pays out at most once per player: replays can't farm coins.
        Index(
            "coin_ledger_one_clear",
            "player_id",
            "game_id",
            "level",
            unique=True,
            postgresql_where=text("reason = 'clear'"),
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    player_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("players.id", ondelete="CASCADE"), nullable=False, index=True
    )
    delta: Mapped[int] = mapped_column(Integer, nullable=False)
    balance_after: Mapped[int] = mapped_column(Integer, nullable=False)
    # welcome | guest_play | clear | streak | assist
    reason: Mapped[str] = mapped_column(String(16), nullable=False)
    game_id: Mapped[str | None] = mapped_column(String(32))
    level: Mapped[int | None] = mapped_column(Integer)
    detail: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )


class PlayEvent(Base):
    """First-party analytics: one row per start, clear, hint, assist or sign-up.

    `who` is a keyed hash of the player or guest id, so distinct players can be
    counted without storing who they are. See DEVELOPMENT.md for queries.
    """

    __tablename__ = "play_events"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), nullable=False
    )
    day: Mapped[date] = mapped_column(Date, server_default=text("CURRENT_DATE"), nullable=False)
    # start | clear | lost | hint | assist | register
    kind: Mapped[str] = mapped_column(String(16), nullable=False)
    game_id: Mapped[str | None] = mapped_column(String(32))
    level: Mapped[int | None] = mapped_column(Integer)
    who: Mapped[str] = mapped_column(String(16), nullable=False)
    signed_in: Mapped[bool] = mapped_column(Boolean, nullable=False)
    stars: Mapped[int | None] = mapped_column(SmallInteger)
    coins: Mapped[int | None] = mapped_column(Integer)
    detail: Mapped[str | None] = mapped_column(String(32))


def make_engine(url: str, pool_size: int, max_overflow: int) -> AsyncEngine:
    return create_async_engine(
        url, pool_size=pool_size, max_overflow=max_overflow, pool_pre_ping=True
    )


def make_sessionmaker(engine: AsyncEngine) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(engine, expire_on_commit=False)


async def session_scope(maker: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    async with maker() as session:
        yield session
